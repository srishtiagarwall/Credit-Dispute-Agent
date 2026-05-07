import { Logger } from '@nestjs/common';
import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { runBureauReconcilerAgent } from '../agents/bureau-reconciler.agent';
import { runAnalyzerAgent } from '../agents/analyzer.agent';
import { runDisputeIdentifierAgent } from '../agents/dispute-identifier.agent';
import { runLetterDrafterAgent } from '../agents/letter-drafter.agent';
import {
  Anomaly,
  BureauConflict,
  CreditReport,
  Dispute,
  DisputeGraphState,
  DisputeLetter,
  GraphStatus,
} from '../types/graph.state';

const logger = new Logger('DisputeGraph');

const DisputeStateAnnotation = Annotation.Root({
  creditReport: Annotation<CreditReport>({
    reducer: (_prev, next) => next,
    default: () => ({} as CreditReport),
  }),
  secondaryReport: Annotation<CreditReport | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  bureauConflicts: Annotation<BureauConflict[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  anomalies: Annotation<Anomaly[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  disputes: Annotation<Dispute[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  letters: Annotation<DisputeLetter[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  errors: Annotation<string[]>({
    reducer: (prev, next) => (next ? [...(prev ?? []), ...next] : prev),
    default: () => [],
  }),
  status: Annotation<GraphStatus>({
    reducer: (_prev, next) => next,
    default: () => 'ANALYZING' as GraphStatus,
  }),
});

type GraphState = typeof DisputeStateAnnotation.State;

// Converts BureauConflicts into BUREAU_CONFLICT Anomalies so they feed into
// the existing dispute identification pipeline without special-casing downstream.
function conflictsToAnomalies(conflicts: BureauConflict[]): Anomaly[] {
  return conflicts.map((c) => ({
    accountId: c.accountId,
    issueType: 'BUREAU_CONFLICT' as const,
    rawDetail:
      `${c.conflictField} conflict: Experian="${c.experianValue}" vs CIBIL="${c.cibilValue}". ` +
      `Ground truth: ${c.groundTruth}. Dispute target: ${c.disputeTarget}. ` +
      `Reasoning: ${c.reasoning}`,
  }));
}

async function bureauReconcilerNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  logger.log(`[${new Date().toISOString()}] bureauReconcilerNode: starting`);

  if (!state.secondaryReport) {
    logger.log(`[${new Date().toISOString()}] bureauReconcilerNode: no secondary report, skipping reconciliation`);
    return { status: 'ANALYZING' };
  }

  try {
    const conflicts = await runBureauReconcilerAgent(
      state.creditReport,
      state.secondaryReport,
    );
    return { bureauConflicts: conflicts, status: 'ANALYZING' };
  } catch (err) {
    const errorMsg = `[${new Date().toISOString()}] bureauReconcilerNode error: ${(err as Error).message}`;
    logger.error(errorMsg);
    return { errors: [errorMsg], status: 'ANALYZING' };
  }
}

async function analyzerNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  logger.log(`[${new Date().toISOString()}] analyzerNode: starting`);
  try {
    const reportAnomalies = await runAnalyzerAgent(state.creditReport);
    const conflictAnomalies = conflictsToAnomalies(state.bureauConflicts ?? []);

    // Merge: conflict anomalies first (higher strategic value), then per-report anomalies.
    // Deduplicate by accountId + issueType so a conflict caught by both paths isn't doubled.
    const seen = new Set<string>();
    const merged: Anomaly[] = [];
    for (const a of [...conflictAnomalies, ...reportAnomalies]) {
      const key = `${a.accountId}::${a.issueType}`;
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(a);
      }
    }

    logger.log(
      `[${new Date().toISOString()}] analyzerNode: ${reportAnomalies.length} report anomalies + ` +
      `${conflictAnomalies.length} bureau conflict anomalies → ${merged.length} total (after dedup)`,
    );

    return { anomalies: merged, status: 'IDENTIFYING' };
  } catch (err) {
    const errorMsg = `[${new Date().toISOString()}] analyzerNode error: ${(err as Error).message}`;
    logger.error(errorMsg);
    return { errors: [errorMsg], status: 'FAILED' };
  }
}

async function disputeIdentifierNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  logger.log(`[${new Date().toISOString()}] disputeIdentifierNode: starting`);
  try {
    const disputes = await runDisputeIdentifierAgent(state.anomalies, state.creditReport);
    return { disputes, status: 'DRAFTING' };
  } catch (err) {
    const errorMsg = `[${new Date().toISOString()}] disputeIdentifierNode error: ${(err as Error).message}`;
    logger.error(errorMsg);
    return { errors: [errorMsg], status: 'FAILED' };
  }
}

async function letterDrafterNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  logger.log(`[${new Date().toISOString()}] letterDrafterNode: starting`);
  try {
    const letters = await runLetterDrafterAgent(state.disputes, state.creditReport.borrower);
    return { letters, status: 'COMPLETE' };
  } catch (err) {
    const errorMsg = `[${new Date().toISOString()}] letterDrafterNode error: ${(err as Error).message}`;
    logger.error(errorMsg);
    return { errors: [errorMsg], status: 'FAILED' };
  }
}

function routeAfterAnalysis(state: GraphState): 'disputeIdentifier' | typeof END {
  if (!state.anomalies || state.anomalies.length === 0) {
    logger.log(`[${new Date().toISOString()}] routeAfterAnalysis: no anomalies, routing to END`);
    return END;
  }
  return 'disputeIdentifier';
}

export async function runDisputeGraph(
  initialState: DisputeGraphState,
): Promise<DisputeGraphState> {
  const graph = new StateGraph(DisputeStateAnnotation)
    .addNode('bureauReconciler', bureauReconcilerNode)
    .addNode('analyzer', analyzerNode)
    .addNode('disputeIdentifier', disputeIdentifierNode)
    .addNode('letterDrafter', letterDrafterNode)
    .addEdge(START, 'bureauReconciler')
    .addEdge('bureauReconciler', 'analyzer')
    .addConditionalEdges('analyzer', routeAfterAnalysis, {
      disputeIdentifier: 'disputeIdentifier',
      [END]: END,
    })
    .addEdge('disputeIdentifier', 'letterDrafter')
    .addEdge('letterDrafter', END);

  const compiled = graph.compile();

  logger.log(`[${new Date().toISOString()}] DisputeGraph: starting execution`);

  const finalState = await compiled.invoke(initialState);

  logger.log(
    `[${new Date().toISOString()}] DisputeGraph: completed — ` +
    `status=${finalState.status}, ` +
    `bureauConflicts=${finalState.bureauConflicts?.length ?? 0}, ` +
    `anomalies=${finalState.anomalies?.length ?? 0}, ` +
    `disputes=${finalState.disputes?.length ?? 0}, ` +
    `letters=${finalState.letters?.length ?? 0}, ` +
    `errors=${finalState.errors?.length ?? 0}`,
  );

  return finalState as DisputeGraphState;
}
