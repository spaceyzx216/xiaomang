
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import App from "./app/App.tsx";
import ContentPage from "./app/ContentPage.tsx";
import FinalEditorPage from "./app/FinalEditorPage.tsx";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<App />} />
      <Route path="/content" element={<ContentPage />} />
      <Route path="/final-editor" element={<FinalEditorPage />} />
    </Routes>
  </BrowserRouter>
);
  