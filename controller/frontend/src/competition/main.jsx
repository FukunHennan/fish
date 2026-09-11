import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CompetitionApp from "./CompetitionApp.jsx";
import "./competition.css";

const root = document.getElementById("competition-root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <CompetitionApp />
    </StrictMode>,
  );
}
