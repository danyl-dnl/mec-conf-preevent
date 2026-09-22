import { createBrowserRouter } from "react-router-dom";

const router = createBrowserRouter([
  {
    path: "/",
    element: <h1>MEC CONF Pre-Event — Participant Portal</h1>,
  },
  {
    path: "/admin",
    element: <h1>MEC CONF Pre-Event — Admin Portal</h1>,
  },
  {
    path: "*",
    element: <h1>404 — Page not found</h1>,
  },
]);

export default router;