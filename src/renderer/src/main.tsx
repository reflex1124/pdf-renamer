import ReactDOM from 'react-dom/client';
import { Theme } from '@radix-ui/themes';

import App from './App';
import '@radix-ui/themes/styles.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <Theme
    accentColor="blue"
    appearance="dark"
    grayColor="slate"
    panelBackground="translucent"
    radius="large"
    scaling="95%"
  >
    <App />
  </Theme>,
);
