const path = require('node:path');
const fs = require('node:fs');
const {
  resolvePath: defaultResolvePath,
} = require('babel-plugin-module-resolver');

// Our source TS files import each other with .js extensions (required by
// tsconfig moduleResolution: bundler / nodenext). babel-plugin-module-resolver
// can't find `src/foo.js` on disk because only `src/foo.ts` exists. Strip the
// .js, run the default resolver, then re-add .js so the emitted ESM output is
// importable by Node.
function resolvePath(sourcePath, currentFile, opts) {
  const tryStripped = sourcePath.replace(/\.js$/, '');
  const resolved = defaultResolvePath(tryStripped, currentFile, opts);
  if (resolved == null) return resolved;

  // The default resolver collapses `dir/index` → `dir`. If the source
  // explicitly imported `<dir>/index(.js)`, restore the suffix so Node ESM
  // (which doesn't auto-resolve directory imports) can find it.
  let final = resolved;
  if (tryStripped.endsWith('/index') && !final.endsWith('/index')) {
    final = final.replace(/\/+$/, '') + '/index';
  }

  if (/\.(js|jsx|cjs|mjs)$/.test(final)) return final;
  // Add .js so Node ESM can resolve at runtime.
  return final + '.js';
}

module.exports = {
  presets: [
    ['@babel/preset-env', { targets: { node: '22' }, modules: false }],
    '@babel/preset-typescript',
    ['@babel/preset-react', { runtime: 'automatic' }],
  ],
  plugins: [
    'babel-plugin-react-compiler',
    [
      'babel-plugin-module-resolver',
      {
        root: ['./'],
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
        resolvePath,
      },
    ],
  ],
};
