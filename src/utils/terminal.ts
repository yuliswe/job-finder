/* eslint-disable no-restricted-syntax */
import chalk from 'chalk';

export const COLOURS = {
  blue: chalk.blue,
  green: chalk.green,
  cyan: chalk.cyan,
  yellow: chalk.yellow,
  red: chalk.red,
  gray: chalk.gray,
};

export const terminal = {
  log: (msg: string, colorFn?: (msg: string) => string) =>
    console.log(colorFn ? colorFn(msg) : COLOURS.blue(msg)),
  warn: (msg: string, colorFn?: (msg: string) => string) =>
    console.warn(colorFn ? colorFn(msg) : COLOURS.yellow(msg)),
  error: (msg: string, colorFn?: (msg: string) => string) =>
    console.error(colorFn ? colorFn(msg) : COLOURS.red(msg)),
  llmResponse: (msg: string, colorFn?: (msg: string) => string) =>
    console.log(colorFn ? colorFn(msg) : COLOURS.cyan(msg)),
  llmRequest: (msg: string, colorFn?: (msg: string) => string) =>
    console.log(colorFn ? colorFn(msg) : COLOURS.gray(msg)),
};

export type Terminal = typeof terminal;
