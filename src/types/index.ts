// Common types used across the application

export interface ExecutionPayload {
  code?: string;
  Global_code?: string;
  global_code?: string;
  command?: string;
  timeout?: number;
  asyncTimeout?: number;
  ai_eval?: boolean;
  encrypt_messages?: boolean;
  background?: boolean;
  priority?: 'low' | 'normal' | 'high';
  maxRetries?: number;
  secure_data_variables?: SecureDataVariables;
  Secure_data_methods?: SecureDataMethods;
  api_calls?: ApiCalls;
  explanation_of_code?: string;
  [key: string]: any;
}

export interface SecureDataVariables {
  [variableName: string]: DataVariableConfig;
}

export interface SecureDataMethods {
  [methodName: string]: DataMethodConfig;
}

export interface ApiCalls {
  [functionName: string]: ApiCallConfig;
}

export interface DataVariableConfig {
  fetchOptions?: FetchOptions;
  headers?: Record<string, string>;
  timeout?: number;
  credential?: string;
  passed_variables?: PassedVariables;
}

export interface DataMethodConfig {
  fetchOptions?: FetchOptions;
  headers?: Record<string, string>;
  timeout?: number;
  credential?: string;
}

export interface ApiCallConfig {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  timeout?: number;
  passed_variables?: PassedVariables;
}

export interface FetchOptions {
  url?: string;
  method?: string;
  body?: any;
}

export interface PassedVariables {
  [fieldName: string]: {
    passed_from: string;
    value: string;
    field_name?: string;
  };
}

export interface Job {
  id: string;
  status: JobStatus;
  payload: ExecutionPayload;
  options: JobOptions;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: JobResult | null;
  error: JobError | null;
  progress: number;
  progressMessage?: string;
}

export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface JobOptions {
  priority?: 'low' | 'normal' | 'high';
  timeout?: number;
  maxRetries?: number;
}

export interface JobResult {
  stdout: string;
  stderr: string;
  code: number;
  executionTime: number;
  executionMode?: string;
  securityFiltered?: boolean;
  aiAnalysis?: any;
  codeAnalysis?: CodeAnalysis;
}

export interface JobError {
  message: string;
  type: string;
  code?: string;
  details?: string;
  stdout?: string;
  stderr?: string;
  executionMode?: string;
}

export interface CodeAnalysis {
  hasEnvironmentAccess: boolean;
  hasExternalApiCalls: boolean;
  hasNodeModuleUsage: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  patterns: Array<{
    type: string;
    matches: number;
    samples: string[];
  }>;
}

export interface ExecutionResult {
  success: boolean;
  data?: {
    stdout: string;
    stderr: string;
    code?: number;
    result?: any;
    errors?: any[];
    executionTime?: number;
    executionMode?: string;
    aiAnalysis?: any;
    codeAnalysis?: CodeAnalysis;
    securityFiltered?: boolean;
    dataMethodsUsed?: string[];
    fallback?: boolean;
  };
  error?: string;
  details?: string;
  executionMode?: string;
}

export interface EncryptedResponse {
  encrypted: true;
  data: string;
  encryptionError?: string;
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Record<string, string | string[]>;
  body: T;
}

export interface HeaderEnvVars {
  [key: string]: string;
}

export interface FileInfo {
  name: string;
  size: number;
  modified: Date;
  created: Date;
}

export interface JobResponse {
  id: string;
  status: JobStatus;
  progress: number;
  progressMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: {
    stdout: string;
    stderr: string;
    code: number;
    executionTime: number;
    aiAnalysis?: any;
  };
  error?: {
    message: string;
    type: string;
    code?: number;
    stdout?: string;
    stderr?: string;
  };
}

export interface JobListResponse {
  success: boolean;
  jobs: Array<{
    id: string;
    status: JobStatus;
    progress: number;
    progressMessage?: string;
    createdAt: string;
    updatedAt: string;
    startedAt?: string;
    completedAt?: string;
    hasResults: boolean;
    hasError: boolean;
  }>;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface JobStatsResponse {
  success: boolean;
  stats: any;
}

export interface ServerResponse {
  success: boolean;
  [key: string]: any;
}

export interface ExecutionOptions {
  timeout?: number;
  env?: Record<string, string>;
  ai_eval?: boolean;
  encrypt_messages?: boolean;
}

export type SecureExecutionResult = ExecutionResult;