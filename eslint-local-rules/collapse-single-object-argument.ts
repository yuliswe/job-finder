import { ESLintUtils, TSESTree } from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  name => `https://example.com/rule/${name}`
);

type Options = [{ maxLineLength?: number }];
type MessageIds = 'collapseObject';

export default createRule<Options, MessageIds>({
  name: 'collapse-single-object-argument',
  meta: {
    type: 'layout',
    docs: {
      description:
        'Collapse single-property object literals (with opening and closing braces on separate lines) into one line.',
    },
    fixable: 'code',
    messages: {
      collapseObject:
        'Object with a single property formatted on multiple lines can be collapsed into one line.',
    },
    schema: [],
  },
  defaultOptions: [{ maxLineLength: 80 }],
  create(context) {
    const { sourceCode } = context;

    /**
     * Determines whether an ObjectExpression is eligible for collapse.
     * Conditions:
     * - Has exactly one property.
     * - Its source text spans multiple lines.
     * - When splitting into lines (ignoring empty/comment-only lines):
     *     Line 1 contains only '{'
     *     Line 2 contains the property (a trailing comma is ignored)
     *     Line 3 contains only '}'
     * - The opening brace '{' is alone on its line.
     */
    function isEligibleObject(node: TSESTree.Node): boolean {
      if (node.type !== TSESTree.AST_NODE_TYPES.ObjectExpression) return false;
      const obj = node;
      if (obj.properties.length !== 1) return false;

      const text = sourceCode.getText(obj);
      if (!text.includes('\n')) return false; // not multiline

      // Get the first token (should be '{')
      const firstToken = sourceCode.getFirstToken(obj);
      if (!firstToken || firstToken.value !== '{') return false;
      // Check that the line containing '{' has no other content
      const firstLine = sourceCode.lines[firstToken.loc.start.line - 1];
      const beforeBrace = firstLine.slice(0, firstToken.loc.start.column);
      const afterBrace = firstLine.slice(firstToken.loc.end.column);
      if (beforeBrace.trim() !== '' || afterBrace.trim() !== '') return false;

      // Split text into lines and filter out empty or comment-only lines.
      const meaningfulLines = text
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(
          line =>
            line &&
            !line.startsWith('//') &&
            !(line.startsWith('/*') && line.endsWith('*/'))
        );

      if (meaningfulLines.length !== 3) return false;
      if (meaningfulLines[0] !== '{' || meaningfulLines[2] !== '}')
        return false;

      // Compare the property line (ignoring a trailing comma) with the AST property text.
      const prop = obj.properties[0];
      const propText = sourceCode.getText(prop).trim();
      const propLine = meaningfulLines[1].replace(/,$/, '').trim();
      return propLine === propText;
    }

    /**
     * Returns the collapsed (one-line) text for an eligible object literal.
     */
    function getCollapsedText(node: TSESTree.Node): string {
      const obj = node as TSESTree.ObjectExpression;
      const prop = obj.properties[0];
      const propText = sourceCode.getText(prop).trim();
      return `{ ${propText} }`;
    }

    return {
      CallExpression(node: TSESTree.CallExpression) {
        // Iterate over the call expression's arguments.
        for (const arg of node.arguments) {
          if (
            arg.type === TSESTree.AST_NODE_TYPES.ObjectExpression &&
            isEligibleObject(arg)
          ) {
            context.report({
              node: arg,
              messageId: 'collapseObject',
              fix: fixer => fixer.replaceText(arg, getCollapsedText(arg)),
            });
          }
        }
      },
    };
  },
});
