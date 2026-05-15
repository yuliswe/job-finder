import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';

type OptionDump = {
  flags: string;
  description?: string;
  required?: true;
  optional?: true;
  variadic?: true;
  mandatory?: true;
  negate?: true;
  hidden?: true;
  choices?: string[];
  default?: unknown;
};

type ArgumentDump = {
  name: string;
  description?: string;
  required?: true;
  variadic?: true;
  choices?: string[];
  default?: unknown;
};

type CommandDump = {
  name: string;
  description?: string;
  summary?: string;
  usage?: string;
  hidden?: true;
  aliases?: string[];
  arguments?: ArgumentDump[];
  options?: OptionDump[];
  commands?: CommandDump[];
};

function dumpOption(option: Option): OptionDump {
  const opt = option as Option & {
    argChoices?: string[];
    defaultValue?: unknown;
    hidden?: boolean;
  };
  return {
    flags: option.flags,
    ...(option.description ? { description: option.description } : {}),
    ...(option.required ? { required: true as const } : {}),
    ...(option.optional ? { optional: true as const } : {}),
    ...(option.variadic ? { variadic: true as const } : {}),
    ...(option.mandatory ? { mandatory: true as const } : {}),
    ...(option.negate ? { negate: true as const } : {}),
    ...(opt.hidden ? { hidden: true as const } : {}),
    ...(opt.argChoices ? { choices: opt.argChoices } : {}),
    ...(opt.defaultValue !== undefined && opt.defaultValue !== null
      ? { default: opt.defaultValue }
      : {}),
  };
}

function dumpArgument(arg: unknown): ArgumentDump {
  const a = arg as {
    _name: string;
    description: string;
    required: boolean;
    variadic: boolean;
    argChoices?: string[];
    defaultValue?: unknown;
  };
  return {
    name: a._name,
    ...(a.description ? { description: a.description } : {}),
    ...(a.required ? { required: true as const } : {}),
    ...(a.variadic ? { variadic: true as const } : {}),
    ...(a.argChoices ? { choices: a.argChoices } : {}),
    ...(a.defaultValue !== undefined && a.defaultValue !== null
      ? { default: a.defaultValue }
      : {}),
  };
}

function dumpCommand(cmd: Command): CommandDump {
  const c = cmd as Command & { _hidden?: boolean };
  const aliases = cmd.aliases();
  const args = (cmd.registeredArguments ?? []).map(dumpArgument);
  const options = cmd.options
    .filter(o => {
      const long = o.long?.replace(/^--/, '');
      return long !== 'help' && long !== 'version';
    })
    .map(dumpOption);
  const commands = cmd.commands
    .filter(sub => sub.name() !== 'help')
    .map(dumpCommand);
  const usage = cmd.usage();
  const summary = cmd.summary();
  return {
    name: cmd.name(),
    ...(cmd.description() ? { description: cmd.description() } : {}),
    ...(summary ? { summary } : {}),
    ...(usage ? { usage } : {}),
    ...(c._hidden ? { hidden: true as const } : {}),
    ...(aliases.length ? { aliases } : {}),
    ...(args.length ? { arguments: args } : {}),
    ...(options.length ? { options } : {}),
    ...(commands.length ? { commands } : {}),
  };
}

export function createHelpMenuDumpCommand(program: Command): Command {
  return new Command('help-menu-dump')
    .description(
      'Dump the full command tree as JSON (writes __generated__/cli/help-menu.json and prints to stdout)'
    )
    .option('--pretty', 'Pretty-print JSON (default)', true)
    .option('--no-pretty', 'Emit compact JSON')
    .action(async (cliOpts: { pretty?: boolean }) => {
      const tree = dumpCommand(program);
      const indent = cliOpts.pretty === false ? 0 : 2;
      const rendered = JSON.stringify(tree, null, indent) + '\n';
      const here = dirname(fileURLToPath(import.meta.url));
      const outputPath = resolve(
        here,
        '../../..',
        '__generated__/cli/help-menu.json'
      );
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered, 'utf-8');
      process.stdout.write(rendered);
      process.stderr.write(`\n# wrote ${outputPath}\n`);
    });
}
