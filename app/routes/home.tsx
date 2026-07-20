import type { Route } from "./+types/home";
import { SalesLoopCRM } from "../crm/sales-loop-crm";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Sales Loop CRM" },
    {
      name: "description",
      content: "Two-loop outbound CRM — queue, contacts, and touchpoint history.",
    },
  ];
}

export function links() {
  return [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
    {
      rel: "stylesheet",
      href: "https://fonts.googleapis.com/css2?family=Geist:wght@400;450;500;600;700;800&family=Geist+Mono:wght@400;500&display=swap",
    },
  ];
}

export default function Home() {
  return <SalesLoopCRM />;
}
