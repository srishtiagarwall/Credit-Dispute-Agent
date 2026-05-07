export interface SubmitDisputeResponse {
  jobId: string;
  status: 'QUEUED';
  message: string;
}

export interface JobResultResponse {
  jobId: string;
  jobStatus: 'active' | 'completed' | 'failed' | 'waiting' | 'unknown';
  result: {
    status: string;
    bureauConflicts: unknown[];
    anomalies: unknown[];
    disputes: unknown[];
    letters: unknown[];
    errors: string[];
  } | null;
}
