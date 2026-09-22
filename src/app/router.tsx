import { createBrowserRouter } from "react-router-dom";
import ParticipantHome from "../pages/participant/ParticipantHome";

const router = createBrowserRouter([
  {
    path: "/",
    element: <ParticipantHome />,
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