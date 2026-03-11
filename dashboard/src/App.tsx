import { createBrowserRouter, RouterProvider, Navigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Endpoints from './pages/Endpoints';
import Suggestions from './pages/Suggestions';
import Graph from './pages/Graph';
import Simulator from './pages/Simulator';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/projects/local" replace />,
  },
  {
    path: '/projects/:projectId',
    Component: Layout,
    children: [
      { index: true, Component: Dashboard },
      { path: 'endpoints', Component: Endpoints },
      { path: 'suggestions', Component: Suggestions },
      { path: 'graph', Component: Graph },
      { path: 'simulator', Component: Simulator },
    ],
  },
]);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
