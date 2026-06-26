import { createElement } from 'react';
import htm from 'htm';

// htm bound to React.createElement gives us JSX-like template literals with no
// build step — `node src/cli.js` just runs. Syntax notes vs JSX:
//   - components interpolate as tags:  html`<${Box}>…<//>`
//   - expressions use ${} (not {}):    height=${rows}
//   - closing tag is <//>
export const html = htm.bind(createElement);
