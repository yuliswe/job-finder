import { render } from 'ink';
import React from 'react';

import { App } from 'src/tui/App.js';

/** Mount Ink and resolve when the user quits. */
export async function renderApp(): Promise<void> {
  const instance = render(<App />);
  await instance.waitUntilExit();
}
