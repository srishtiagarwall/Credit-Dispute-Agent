import { Logger } from '@nestjs/common';
import { StateGraph, Annotation, END, START } from '@langchain/langgraph';
import { runAnalyzerAgent } from '../agents/analyzer.agent';
import { runDisputeIdentifierAgent } from '../agents/dispute-identifier.agent';
import { runLetterDrafterAgent } from '../agents/letter-drafter.agent';
import {
  Anomaly,
  CreditReport,
  Dispute,
  DisputeLetter,
  DisputeGraphState,
  GraphStatus,
} from '../types/graph.state';

const logger = new Logger('DisputeGraph');

const DisputeStateAnnotation = Annotation.Root({
  creditReport: Annotation<CreditReport>({
    reducer: (_prev, next) => next,
    default: () => ({} as CreditReport),
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

async function analyzerNode(
  state: GraphState,
): Promise<Partial<GraphState>> {
  logger.log(`[${new Date().toISOString()}] analyzerNode: starting`);
  try {
    const anomalies = await runAnalyzerAgent(state.creditReport);
    return { anomalies, status: 'IDENTIFYING' };
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
    logger.log(`[${new Date().toISOString()}] routeAfterAnalysis: no anomalies found, routing to END`);
    return END;
  }
  return 'disputeIdentifier';
}

export async function runDisputeGraph(
  initialState: DisputeGraphState,
): Promise<DisputeGraphState> {
  const graph = new StateGraph(DisputeStateAnnotation)
    .addNode('analyzer', analyzerNode)
    .addNode('disputeIdentifier', disputeIdentifierNode)
    .addNode('letterDrafter', letterDrafterNode)
    .addEdge(START, 'analyzer')
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
    `[${new Date().toISOString()}] DisputeGraph: completed with status=${finalState.status}, ` +
    `anomalies=${finalState.anomalies?.length ?? 0}, disputes=${finalState.disputes?.length ?? 0}, ` +
    `letters=${finalState.letters?.length ?? 0}, errors=${finalState.errors?.length ?? 0}`,
  );

  return finalState as DisputeGraphState;
}
