// SSR entry.
//
// Deliberately thin: no schedulers, no product bootstrapping at module load.
// Background work belongs to the JobRunner.
export { default } from "@tanstack/react-start/server-entry";
