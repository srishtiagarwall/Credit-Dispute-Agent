export type IssueType =
  | 'LATE_PAYMENT'
  | 'INCORRECT_STATUS'
  | 'DUPLICATE_ACCOUNT'
  | 'HIGH_UTILIZATION'
  | 'UNKNOWN_INQUIRY'
  | 'BUREAU_CONFLICT';

export type DisputeSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type GraphStatus =
  | 'RECONCILING'
  | 'ANALYZING'
  | 'IDENTIFYING'
  | 'DRAFTING'
  | 'COMPLETE'
  | 'FAILED';

export type ConflictField =
  | 'accountStatus'
  | 'balance'
  | 'creditLimit'
  | 'paymentHistory'
  | 'accountMissing'
  | 'inquiryMissing';

export type GroundTruthVerdict = 'EXPERIAN' | 'CIBIL' | 'UNRESOLVABLE';

export interface BureauConflict {
  accountId: string;
  conflictField: ConflictField;
  experianValue: string;
  cibilValue: string;
  groundTruth: GroundTruthVerdict;
  reasoning: string;
  disputeTarget: 'EXPERIAN' | 'CIBIL' | 'BOTH';
}

export interface Account {
  accountId: string;
  lenderName: string;
  accountType: 'CREDIT_CARD' | 'PERSONAL_LOAN' | 'HOME_LOAN' | 'AUTO_LOAN';
  accountStatus: string;
  balance: number;
  creditLimit: number;
  paymentHistory: PaymentRecord[];
  openedDate: string;
}

export interface PaymentRecord {
  month: string;
  status: 'ON_TIME' | 'LATE_30' | 'LATE_60' | 'LATE_90' | 'MISSED';
}

export interface Inquiry {
  inquiryId: string;
  lenderName: string;
  inquiryDate: string;
  purpose: string;
}

export interface Borrower {
  name: string;
  pan: string;
  dateOfBirth: string;
  address: string;
}

export interface CreditReport {
  reportId: string;
  bureau: string;
  reportDate: string;
  creditScore: number;
  borrower: Borrower;
  accounts: Account[];
  inquiries: Inquiry[];
}

export interface Anomaly {
  accountId: string;
  issueType: IssueType;
  rawDetail: string;
}

export interface Dispute {
  accountId: string;
  disputeCategory: string;
  lenderName: string;
  severity: DisputeSeverity;
  recommendedAction: string;
}

export interface DisputeLetter {
  letterId: string;
  lenderName: string;
  accountId: string;
  subject: string;
  body: string;
  generatedAt: string;
}

export interface DisputeGraphState {
  creditReport: CreditReport;
  secondaryReport: CreditReport | null;
  bureauConflicts: BureauConflict[];
  anomalies: Anomaly[];
  disputes: Dispute[];
  letters: DisputeLetter[];
  errors: string[];
  status: GraphStatus;
}
