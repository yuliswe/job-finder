/* eslint-disable no-restricted-syntax */
import chalk from 'chalk';

export const terminal = {
  log: (msg: string) => console.log(chalk.blue(msg)),
  warn: (msg: string) => console.warn(chalk.yellow(msg)),
  error: (msg: string) => console.error(chalk.red(msg)),
};
