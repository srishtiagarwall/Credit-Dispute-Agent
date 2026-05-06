# Credit Dispute Agent Pipeline

A production-intentional multi-agent AI system that processes credit reports, detects anomalies, classifies disputes, and drafts formal dispute letters — all orchestrated through a LangGraph state machine and processed asynchronously via BullMQ.

---

## Architecture

```
POST /dispute/submit
        │
        ▼
┌───────────────────┐
│  DisputeController │  Loads mock/credit-report.json, returns jobId immediately
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   BullMQ Queue     │  "dispute-processing" queue — async, retries 3x with exponential backoff
│   (Redis-backed)   │
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│   DisputeWorker    │  concurrency=2, picks up jobs and runs the graph
└────────┬──────────┘
         │
         ▼
┌────────────────────────────────────────────────────────┐
│                  LangGraph State Machine                │
│                                                        │
│  ┌──────────────┐    ┌──────────────────┐    ┌───────────────────┐
│  │   Agent 1    │───▶│     Agent 2      │───▶│     Agent 3       │
│  │  Analyzer    │    │ DisputeIdentifier│    │  LetterDrafter    │
│  │              │    │                  │    │                   │
│  │ Flags:       │    │ Classifies each  │    │ Drafts formal     │
│  │ - LATE_PAY   │    │ anomaly into a   │    │ dispute letters   │
│  │ - BAD_STATUS │    │ dispute with     │    │ for HIGH+MEDIUM   │
│  │ - HIGH_UTIL  │    │ severity + action│    │ severity disputes │
│  │ - DUPLICATE  │    │                  │    │                   │
│  │ - UNK_INQUIRY│    └──────────────────┘    └───────────────────┘
│  └──────────────┘
│       │
│       └── if anomalies=0 → END (skip remaining agents)
│
└────────────────────────────────────────────────────────┘
         │
         ▼
  DisputeGraphState
  { anomalies[], disputes[], letters[], status, errors[] }
```

---

## Tech Stack & Decisions

| Technology | Why |
|---|---|
| **NestJS** | Dependency injection + lifecycle hooks (`OnModuleInit`/`OnModuleDestroy`) make wiring producers/workers clean without global state. |
| **LangGraph** | Explicit typed state machine with conditional routing — far more controllable than a plain LangChain chain when agents need to short-circuit or error-collect gracefully. |
| **Gemini (gemini-2.5-pro)** | High throughput, low latency for structured JSON extraction tasks; `systemInstruction` field provides clean role separation. |
| **BullMQ + Redis** | Durable job queue with built-in retry/backoff, concurrency control, and visibility into job state — decouples the HTTP request lifecycle from multi-second LLM processing. |
| **ioredis** | BullMQ's recommended Redis client; supports `maxRetriesPerRequest: null` required by BullMQ workers. |

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- Redis running on `localhost:6379` (or Docker: `docker run -p 6379:6379 redis`)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/)

### Steps

```bash
# 1. Clone the repo
git clone <repo-url>
cd credit-dispute-agent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env — set GEMINI_API_KEY=your_actual_key

# 4. Start the server
npm run start:dev

# 5. Trigger a dispute run
curl -X POST http://localhost:3000/dispute/submit
```

The API responds immediately. Watch the terminal logs for the three agents executing sequentially.

---

## Sample Output

### POST /dispute/submit → HTTP 202

```json
{
  "jobId": "42",
  "status": "QUEUED",
  "message": "Processing started"
}
```

### Worker log output (structured)

```
[DisputeWorker] processing job 42 for reportId=EXP-2024-110293847
[analyzerNode] starting
[AnalyzerAgent] sending request to Gemini
[AnalyzerAgent] found 5 anomalies
[disputeIdentifierNode] starting
[DisputeIdentifierAgent] classifying 5 anomalies
[DisputeIdentifierAgent] classified 5 disputes
[letterDrafterNode] starting
[LetterDrafterAgent] drafting letters for 4 disputes
[LetterDrafterAgent] drafted 4 letters
[DisputeWorker] job 42 completed — status=COMPLETE, anomalies=5, disputes=5, letters=4
```

### Sample DisputeLetter (structured JSON)

```json
{
  "letterId": "LETTER-20241101-A7B2",
  "lenderName": "State Bank of India",
  "accountId": "SBI-HL-00938271",
  "subject": "Formal Dispute: Incorrect WRITTEN_OFF Status on Home Loan Account SBI-HL-00938271",
  "body": "Dear Sir/Madam,\n\nI, Rahul Mehta, writing to formally dispute the account status reported as 'WRITTEN_OFF' for my Home Loan account (Account ID: SBI-HL-00938271)...\n\nPursuant to Section 611 of the Fair Credit Reporting Act (FCRA), I formally request that you investigate this matter and correct the account status to ACTIVE within 30 days.\n\nSincerely,\nRahul Mehta\n42, Shivaji Nagar, Pune, Maharashtra - 411005",
  "generatedAt": "2024-11-01T09:15:32.000Z"
}
```

### Sample plain-text letter (the `body` field rendered)

```
Dear Sir/Madam,

I, Rahul Mehta, am writing to formally dispute the account status reported
as 'WRITTEN_OFF' for my Home Loan account (Account ID: SBI-HL-00938271)
at Experian Credit Bureau.

Upon reviewing my credit report dated November 1, 2024, I have identified
that the above account is incorrectly marked as WRITTEN_OFF despite a
consistent record of on-time payments for the past 5 months. This reporting
is materially inaccurate and is adversely impacting my credit score.

Pursuant to Section 611 of the Fair Credit Reporting Act (FCRA), I formally
request that you investigate this matter and correct the account status to
ACTIVE within 30 days of receipt of this letter.

Please provide written confirmation of the correction at the address below.

Sincerely,
Rahul Mehta
42, Shivaji Nagar, Pune, Maharashtra - 411005
```

---

## Design Decisions

### 1. Async queue over synchronous processing
LLM calls for 3 agents take 10–30 seconds end-to-end. Accepting the HTTP request, enqueuing, and returning a `jobId` immediately prevents HTTP timeout failures and allows the server to handle concurrent submissions without blocking. BullMQ's Redis persistence also means jobs survive server restarts.

### 2. Graceful error collection over throwing
Each agent node catches errors and appends to `state.errors[]` rather than throwing. This means if Agent 2 fails, Agent 3 still runs with whatever partial state is available, and the job completes with `status=FAILED` but with a full error trace. A hard throw would silently lose the output of successful upstream agents.

### 3. LangGraph state machine over a plain async chain
A plain `await agent1(); await agent2(); await agent3()` chain gives you no conditional routing, no typed state transitions, and no clean hook points for observability. LangGraph provides: explicit state typing, conditional edges (skip to END if no anomalies), and a clear mental model of which node transforms which slice of state — which matters when you add agents or branching later.

### 4. Structured JSON output contract per agent
Each agent is explicitly prompted to return a JSON array with a specified schema. The agent functions then regex-extract the JSON block and `JSON.parse` it — rather than trusting freeform LLM output. This makes agent output deterministic enough to be composed: Agent 2 consumes Agent 1's typed `Anomaly[]`, Agent 3 consumes Agent 2's typed `Dispute[]`.
