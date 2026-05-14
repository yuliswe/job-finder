import {
  AST_NODE_TYPES,
  ESLintUtils,
  TSESTree,
} from '@typescript-eslint/utils';

const createRule = ESLintUtils.RuleCreator(
  ruleName => `https://example.com/rule/${ruleName}`
);

type MessageIds = 'incorrectOrder';
type Options = [];

export default createRule<Options, MessageIds>({
  name: 'sort-function-argument-props',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Enforce ordering of object literal properties in function arguments and inline function parameter type literals: required non-functions, required functions, optional non-functions, then optional functions.',
    },
    messages: {
      incorrectOrder:
        'Object properties must be ordered as: required non-functions, required functions, optional non-functions, then optional functions.',
    },
    fixable: 'code',
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const { sourceCode } = context;

    // Helper for sorting object literal properties.
    function getObjectPropertyOrder(prop: TSESTree.Property): number {
      const { optional } = prop;
      const isFunction =
        prop.value.type === AST_NODE_TYPES.FunctionExpression ||
        prop.value.type === AST_NODE_TYPES.ArrowFunctionExpression;
      if (!optional && !isFunction) return 0;
      if (!optional && isFunction) return 1;
      if (optional && !isFunction) return 2;
      return 3;
    }

    // Given an array of properties, return them sorted (stable sort).
    function sortProperties<
      T extends { order: number; index: number; node: TSESTree.Property },
    >(props: T[]): T[] {
      return props.slice().sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        return a.index - b.index;
      });
    }

    // Check object literal expressions (in CallExpression).
    function checkObjectExpression(node: TSESTree.ObjectExpression): void {
      if (node.parent.type !== AST_NODE_TYPES.CallExpression) {
        return;
      }
      const properties = node.properties.filter(
        (prop): prop is TSESTree.Property =>
          prop.type === AST_NODE_TYPES.Property
      );
      // Map each property with its current index and computed order.
      const propsWithOrder = properties.map((prop, idx) => ({
        order: getObjectPropertyOrder(prop),
        index: idx,
        node: prop,
      }));
      const sorted = sortProperties(propsWithOrder);
      // Compare original order with sorted order.
      for (let i = 0; i < propsWithOrder.length; i++) {
        if (propsWithOrder[i].node !== sorted[i].node) {
          // Report error on the entire object expression with a fixer.
          context.report({
            node,
            messageId: 'incorrectOrder',
            fix: fixer => {
              // Get tokens for the braces.
              const openBrace = sourceCode.getFirstToken(node)!;
              const closeBrace = sourceCode.getLastToken(node)!;
              // Build the fixed properties text.
              // We use sourceCode.getText for each property.
              const sortedText = sorted
                .map(propObj => sourceCode.getText(propObj.node))
                .join(', ');
              return fixer.replaceTextRange(
                [openBrace.range[1], closeBrace.range[0]],
                ` ${sortedText} `
              );
            },
          });
          break;
        }
      }
    }

    // Helper for TS type literal properties.
    function getTSPropertyOrder(prop: TSESTree.TSPropertySignature): number {
      const { optional } = prop;
      let isFunction = false;
      if (prop.typeAnnotation?.typeAnnotation) {
        const ta = prop.typeAnnotation.typeAnnotation;
        isFunction = ta.type === AST_NODE_TYPES.TSFunctionType;
      }
      if (!optional && !isFunction) return 0;
      if (!optional && isFunction) return 1;
      if (optional && !isFunction) return 2;
      return 3;
    }

    function sortTSProperties<
      T extends {
        order: number;
        index: number;
        node: TSESTree.TSPropertySignature;
      },
    >(props: T[]): T[] {
      return props.slice().sort((a, b) => {
        if (a.order !== b.order) {
          return a.order - b.order;
        }
        return a.index - b.index;
      });
    }

    function checkTSTypeLiteral(node: TSESTree.TSTypeLiteral): void {
      if (
        node.parent.type !== AST_NODE_TYPES.TSTypeAnnotation ||
        !(
          node.parent.parent.type === AST_NODE_TYPES.Identifier ||
          node.parent.parent.type === AST_NODE_TYPES.AssignmentPattern ||
          node.parent.parent.type === AST_NODE_TYPES.RestElement
        )
      ) {
        return;
      }
      const members = node.members.filter(
        (member): member is TSESTree.TSPropertySignature =>
          member.type === AST_NODE_TYPES.TSPropertySignature
      );
      const membersWithOrder = members.map((member, idx) => ({
        order: getTSPropertyOrder(member),
        index: idx,
        node: member,
      }));
      const sorted = sortTSProperties(membersWithOrder);
      for (let i = 0; i < membersWithOrder.length; i++) {
        if (membersWithOrder[i].node !== sorted[i].node) {
          context.report({
            node,
            messageId: 'incorrectOrder',
            fix: fixer => {
              // Get the text for each member.
              // Note: This simple approach does not preserve comments or original indentation.
              const sortedText = sorted
                .map(memberObj => sourceCode.getText(memberObj.node))
                .join('\n');
              // Calculate the fix range: between the first and last member tokens.
              const firstToken = sourceCode.getFirstToken(node)!;
              const lastToken = sourceCode.getLastToken(node)!;
              return fixer.replaceTextRange(
                [firstToken.range[1], lastToken.range[0]],
                ` ${sortedText} `
              );
            },
          });
          break;
        }
      }
    }

    return {
      'CallExpression > ObjectExpression': checkObjectExpression,
      TSTypeLiteral: checkTSTypeLiteral,
    };
  },
});
