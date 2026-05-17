import { render } from 'ink';
import React from 'react';

import { App, type AppOptions } from 'src/tui/App.js';

/** Mount Ink and resolve when the user quits. */
export async function renderApp(options: AppOptions): Promise<void> {
  const instance = render(<App initial={options} />);
  await instance.waitUntilExit();
}
