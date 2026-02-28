import { createBrowserRouter } from 'react-router';
import { Layout } from './layout/Layout';
import { LandingLayout } from './layout/LandingLayout';
import { LandingPage } from './components/landing-page';
import Projects from './pages/Projects';
import About from './pages/About';
import Docs from './pages/Docs';
import Dashboard from './pages/Dashboard';
import Endpoints from './pages/Endpoints';
import Suggestions from './pages/Suggestions';
import Graph from './pages/Graph';
import AiChat from './pages/AiChat';

export const router = createBrowserRouter([
  {
    path: '/',
    Component: LandingLayout,
    children: [
      { index: true, Component: LandingPage },
      { path: 'projects', Component: Projects },
      { path: 'about', Component: About },
      { path: 'docs', Component: Docs },
    ],
  },
  {
    path: '/projects/:projectId',
    Component: Layout,
    children: [
      { index: true, Component: Dashboard },
      { path: 'endpoints', Component: Endpoints },
      { path: 'suggestions', Component: Suggestions },
      { path: 'graph', Component: Graph },
      { path: 'chat', Component: AiChat },
    ],
  },
]);
