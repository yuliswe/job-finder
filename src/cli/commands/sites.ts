import { Command } from 'commander';

import type { JobType, Site } from 'src/python-jobspy/index.js';
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

export function createSitesCommand(): Command {
  return new Command('sites')
    .description('List supported job sites and job types')
    .action(() => {
      const lines = [
        'Sites:',
        ...SITES.map(s => `  ${s}`),
        '',
        'Job types:',
        ...JOB_TYPES.map(j => `  ${j}`),
        '',
      ];
      terminal.log(lines.join('\n'), s => s);
    });
}
