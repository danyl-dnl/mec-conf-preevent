import { createBrowserRouter } from "react-router-dom";
import ParticipantHome from "../pages/participant/ParticipantHome";
import AdminHome from "../pages/admin/AdminHome";

const router = createBrowserRouter([
  {
    path: "/",
    element: <ParticipantHome />,
  },
  {
    path: "/admin",
    element: <AdminHome />,
  },
  {
    path: "*",
    element: <h1>404 — Page not found</h1>,
  },
]);

export default router;