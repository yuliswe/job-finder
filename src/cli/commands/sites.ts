import { Command } from 'commander';

import type { JobType, Site } from 'src/python-jobspy/index.js';

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
      process.stdout.write(lines.join('\n'));
    });
}
