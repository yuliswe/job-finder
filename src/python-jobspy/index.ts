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
  /** How to handle the child's stderr.
   *
   * - `'tee'` (default): pipe to the parent process so we can capture it on
   *   `JobspyError.stderr`, while still streaming each chunk to
   *   `process.stderr` in real time. Use this when callers need to inspect
   *   the trace (e.g. to decide whether an error is unrecoverable).
   * - `'inherit'` / `'pipe'` / `'ignore'`: forwarded directly to spawn. Note
   *   `'inherit'` leaves `stderr` on the error empty. */
  stderr?: 'tee' | 'inherit' | 'pipe' | 'ignore';
};

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, 'runner.py');

export class JobspyError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null = null
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

  const stderrMode = config.stderr ?? 'tee';
  const spawnStderr = stderrMode === 'tee' ? 'pipe' : stderrMode;

  return new Promise((resolveP, rejectP) => {
    const proc = spawn(cmd, [...launcherArgs, RUNNER], {
      cwd: config.cwd,
      stdio: ['pipe', 'pipe', spawnStderr],
    });

    const childStdin = proc.stdin!;
    const childStdout = proc.stdout!;

    let stdout = '';
    let stderrBuf = '';
    let settled = false;

    // Single-shot reject so the first failure wins. Stream and process events
    // can fire in either order (spawn ENOENT fires both `error` and `close`;
    // a Python crash mid-stream can fire stream `error` before `close`), and
    // we want exactly one JobspyError per call.
    const fail = (err: JobspyError): void => {
      if (settled) return;
      settled = true;
      rejectP(err);
    };

    const succeed = (result: JobResult[]): void => {
      if (settled) return;
      settled = true;
      resolveP(result);
    };

    childStdout.setEncoding('utf8');

    childStdout.on('data', (chunk: string) => {
      stdout += chunk;
    });

    childStdout.on('error', err => {
      fail(
        new JobspyError(`stdout stream error: ${err.message}`, stderrBuf, null)
      );
    });

    if (proc.stderr) {
      proc.stderr.setEncoding('utf8');

      proc.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
        if (stderrMode === 'tee') process.stderr.write(chunk);
      });

      proc.stderr.on('error', err => {
        fail(
          new JobspyError(
            `stderr stream error: ${err.message}`,
            stderrBuf,
            null
          )
        );
      });
    }

    // If the child dies before draining stdin, the write fails with EPIPE.
    // Without this listener that becomes an unhandled 'error' event and
    // crashes the Node process — capture it and convert to a JobspyError so
    // `close` (which fires shortly after) finds the promise already failed.
    childStdin.on('error', err => {
      fail(
        new JobspyError(
          `failed to write options to jobspy runner stdin: ${err.message}`,
          stderrBuf,
          null
        )
      );
    });

    proc.on('error', err => {
      fail(
        new JobspyError(
          `failed to spawn ${cmd}: ${err.message}`,
          stderrBuf,
          null
        )
      );
    });

    proc.on('close', (code, signal) => {
      if (signal != null) {
        fail(
          new JobspyError(
            `jobspy runner killed by signal ${signal}`,
            stderrBuf,
            code,
            signal
          )
        );
        return;
      }

      if (code !== 0) {
        fail(
          new JobspyError(
            `jobspy runner exited with code ${code}`,
            stderrBuf,
            code
          )
        );
        return;
      }

      if (stdout.trim() === '') {
        fail(
          new JobspyError(
            'jobspy runner exited cleanly but produced no output',
            stderrBuf,
            code
          )
        );
        return;
      }

      try {
        succeed(JSON.parse(stdout) as JobResult[]);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);

        fail(
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
