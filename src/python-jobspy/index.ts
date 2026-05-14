import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Site =
  | 'linkedin'
  | 'indeed'
  | 'zip_recruiter'
  | 'glassdoor'
  | 'google'
  | 'bayt'
  | 'naukri'
  | 'bdjobs';

export type JobType =
  | 'fulltime'
  | 'parttime'
  | 'contract'
  | 'temporary'
  | 'internship'
  | 'perdiem'
  | 'nights'
  | 'other'
  | 'summer'
  | 'volunteer';

export type DescriptionFormat = 'markdown' | 'html';

export type SalaryInterval =
  | 'yearly'
  | 'monthly'
  | 'weekly'
  | 'daily'
  | 'hourly';

export type ScrapeJobsOptions = {
  site_name?: Site | Site[];
  search_term?: string;
  google_search_term?: string;
  location?: string;
  distance?: number;
  is_remote?: boolean;
  job_type?: JobType;
  easy_apply?: boolean;
  results_wanted?: number;
  country_indeed?: string;
  proxies?: string | string[];
  ca_cert?: string;
  description_format?: DescriptionFormat;
  linkedin_fetch_description?: boolean;
  linkedin_company_ids?: number[];
  offset?: number;
  hours_old?: number;
  enforce_annual_salary?: boolean;
  verbose?: 0 | 1 | 2;
  user_agent?: string;
};

export type JobResult = {
  id: string | null;
  site: Site;
  job_url: string;
  job_url_direct: string | null;
  title: string;
  company: string | null;
  location: string | null;
  date_posted: string | null;
  job_type: string | null;
  salary_source: string | null;
  interval: SalaryInterval | null;
  min_amount: number | null;
  max_amount: number | null;
  currency: string | null;
  is_remote: boolean | null;
  job_level: string | null;
  job_function: string | null;
  listing_type: string | null;
  emails: string | null;
  description: string | null;
  company_industry: string | null;
  company_url: string | null;
  company_logo: string | null;
  company_url_direct: string | null;
  company_addresses: string | null;
  company_num_employees: string | null;
  company_revenue: string | null;
  company_description: string | null;
  skills: string | null;
  experience_range: string | null;
  company_rating: number | null;
  company_reviews_count: number | null;
  vacancy_count: number | null;
  work_from_home_type: string | null;
};

export type RunnerConfig = {
  /** Python launcher; defaults to `poetry run python`. */
  python?: readonly string[];
  /** Working dir for the subprocess; defaults to inherited cwd. */
  cwd?: string;
  /** Forwarded to the child stderr stream; defaults to 'inherit'. */
  stderr?: 'inherit' | 'pipe' | 'ignore';
};

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, 'runner.py');

export class JobspyError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null
  ) {
    super(message);
    this.name = 'JobspyError';
  }
}

export function scrapeJobs(
  options: ScrapeJobsOptions = {},
  config: RunnerConfig = {}
): Promise<JobResult[]> {
  const launcher = config.python ?? ['poetry', 'run', 'python'];
  const [cmd, ...launcherArgs] = launcher;
  if (!cmd) {
    return Promise.reject(
      new JobspyError('python launcher is empty', '', null)
    );
  }
  const stderrMode = config.stderr ?? 'inherit';

  return new Promise((resolveP, rejectP) => {
    const proc = spawn(cmd, [...launcherArgs, RUNNER], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', stderrMode],
    });
    const childStdin = proc.stdin!;
    const childStdout = proc.stdout!;

    let stdout = '';
    let stderrBuf = '';
    childStdout.setEncoding('utf8');
    childStdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
      });
    }

    proc.on('error', err => {
      rejectP(
        new JobspyError(
          `failed to spawn ${cmd}: ${err.message}`,
          stderrBuf,
          null
        )
      );
    });

    proc.on('close', code => {
      if (code !== 0) {
        rejectP(
          new JobspyError(
            `jobspy runner exited with code ${code}`,
            stderrBuf,
            code
          )
        );
        return;
      }
      try {
        resolveP(JSON.parse(stdout) as JobResult[]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        rejectP(
          new JobspyError(
            `failed to parse jobspy output as JSON: ${reason}`,
            stderrBuf,
            code
          )
        );
      }
    });

    childStdin.end(JSON.stringify(options));
  });
}
