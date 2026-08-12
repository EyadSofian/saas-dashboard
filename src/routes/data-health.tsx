import { createFileRoute } from "@tanstack/react-router";
import { PlaceholderPage } from "@/components/layout/PlaceholderPage";

export const Route = createFileRoute("/data-health")({
  component: () => <PlaceholderPage page="data-health" />,
});
