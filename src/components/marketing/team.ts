/** The roles customers work with, in workflow order (keys from the real agent registry). */
export const TEAM = [
  { key: "product-manager", role: "Product manager", does: "Turns your idea into a brief, user stories, acceptance criteria and a dependency-ordered backlog — and asks only the questions that change scope." },
  { key: "designer", role: "Designer", does: "Specifies pages, components, states and responsive behaviour, then hands developers an approved design to build against." },
  { key: "architect", role: "Architect", does: "Reads your codebase and records the data model, contracts and decisions the implementation must follow." },
  { key: "backend-engineer", role: "Backend engineer", does: "Implements APIs, data and business logic in your repository, writes tests, and runs them before handing over." },
  { key: "frontend-engineer", role: "Frontend engineer", does: "Builds the interface from the approved design and wires it to the API." },
  { key: "qa-engineer", role: "QA engineer", does: "Checks every acceptance criterion against real test output. Unproven criteria stay unproven." },
  { key: "security-engineer", role: "Security reviewer", does: "Reviews authentication, authorization, input handling, secrets and dependencies — with file-level evidence." },
  { key: "reviewer", role: "Code reviewer", does: "Reviews correctness and completeness; blocking issues go straight back to the engineer." },
] as const;
