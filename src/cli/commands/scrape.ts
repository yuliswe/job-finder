import { writeFile } from 'node:fs/promises';

import { Command, Option } from 'commander';

import {
  scrapeJobs,
  type DescriptionFormat,
  type JobResult,
  type JobType,
  type ScrapeJobsOptions,
  type Site,
} from 'src/python-jobspy/index.js';
import { terminal } from 'src/utils/terminal.js';

const SITES: Site[] = [
  'linkedin',
  'indeed',
  'zip_recruiter',
  'glassdoor',
  'google',
  'bayt',
  'naukri',
  'bdjobs',
];

const JOB_TYPES: JobType[] = [
  'fulltime',
  'parttime',
  'contract',
  'temporary',
  'internship',
  'perdiem',
  'nights',
  'other',
  'summer',
  'volunteer',
];

const DESCRIPTION_FORMATS: DescriptionFormat[] = ['markdown', 'html'];

type ScrapeCliOpts = {
  site: Site[];
  search?: string;
  googleSearch?: string;
  location?: string;
  distance?: string;
  remote?: boolean;
  jobType?: JobType;
  easyApply?: boolean;
  results?: string;
  country?: string;
  proxy?: string[];
  caCert?: string;
  descriptionFormat?: DescriptionFormat;
  linkedinFetchDescription?: boolean;
  linkedinCompanyId?: string[];
  offset?: string;
  hoursOld?: string;
  enforceAnnualSalary?: boolean;
  verbose?: string;
  userAgent?: string;
  format: 'json' | 'csv';
  output?: string;
};

export function createScrapeCommand(): Command {
  return new Command('scrape')
    .description('Scrape jobs via python-jobspy')
    .addOption(
      new Option('-s, --site <site...>', 'Sites to scrape')
        .choices(SITES)
        .default(['indeed'])
    )
    .option('-q, --search <term>', 'Search term')
    .option('--google-search <term>', 'Google natural-language search term')
    .option('-l, --location <location>', 'Location')
    .option('-d, --distance <miles>', 'Distance in miles', '50')
    .option('--remote', 'Remote only')
    .addOption(new Option('--job-type <type>', 'Job type').choices(JOB_TYPES))
    .option('--easy-apply', 'LinkedIn easy-apply only')
    .option('-n, --results <count>', 'Results wanted per site', '15')
    .option('--country <country>', 'country_indeed (e.g. usa, canada)', 'usa')
    .option('--proxy <proxy...>', 'Proxy URL (repeatable)')
    .option('--ca-cert <path>', 'CA cert path')
    .addOption(
      new Option('--description-format <fmt>', 'Description format').choices(
        DESCRIPTION_FORMATS
      )
    )
    .option('--linkedin-fetch-description', 'Fetch full LinkedIn descriptions')
    .option('--linkedin-company-id <id...>', 'LinkedIn company IDs to filter')
    .option('--offset <n>', 'Pagination offset')
    .option('--hours-old <hours>', 'Only jobs newer than N hours')
    .option('--enforce-annual-salary', 'Convert salaries to annual')
    .option('--verbose <level>', 'Verbosity 0|1|2', '0')
    .option('--user-agent <ua>', 'User-Agent override')
    .addOption(
      new Option('-f, --format <format>', 'Output format')
        .choices(['json', 'csv'])
        .default('json')
    )
    .option('-o, --output <file>', 'Write to file instead of stdout')
    .action(async (cliOpts: ScrapeCliOpts) => {
      const options = toScrapeOptions(cliOpts);
      const jobs = await scrapeJobs(options);
      const rendered = render(jobs, cliOpts.format);
      if (cliOpts.output) {
        await writeFile(cliOpts.output, rendered);
        console.error(`wrote ${jobs.length} rows to ${cliOpts.output}`);
      } else {
        terminal.log(rendered, s => s);
      }
    });
}

function toScrapeOptions(o: ScrapeCliOpts): ScrapeJobsOptions {
  const verbose = o.verbose ? Number(o.verbose) : undefined;
  return {
    site_name: o.site,
    search_term: o.search,
    google_search_term: o.googleSearch,
    location: o.location,
    distance: o.distance ? Number(o.distance) : undefined,
    is_remote: o.remote,
    job_type: o.jobType,
    easy_apply: o.easyApply,
    results_wanted: o.results ? Number(o.results) : undefined,
    country_indeed: o.country,
    proxies: o.proxy,
    ca_cert: o.caCert,
    description_format: o.descriptionFormat,
    linkedin_fetch_description: o.linkedinFetchDescription,
    linkedin_company_ids: o.linkedinCompanyId?.map(Number),
    offset: o.offset ? Number(o.offset) : undefined,
    hours_old: o.hoursOld ? Number(o.hoursOld) : undefined,
    enforce_annual_salary: o.enforceAnnualSalary,
    verbose:
      verbose === 0 || verbose === 1 || verbose === 2 ? verbose : undefined,
    user_agent: o.userAgent,
  };
}

function render(jobs: JobResult[], format: 'json' | 'csv'): string {
  if (format === 'json') return JSON.stringify(jobs, null, 2) + '\n';
  return toCsv(jobs);
}

function toCsv(jobs: JobResult[]): string {
  if (jobs.length === 0) return '';
  const first = jobs[0] as JobResult;
  const cols = Object.keys(first) as (keyof JobResult)[];
  const header = cols.join(',');
  const body = jobs
    .map(j => cols.map(c => escapeCsv(j[c])).join(','))
    .join('\n');
  return `${header}\n${body}\n`;
}

function escapeCsv(value: JobResult[keyof JobResult]): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
