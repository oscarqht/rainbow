import type { Library } from "./types";
export function demoLibrary(): Library {
  const date = "2026-10-13T08:00:00.000Z";
  const examples = [
    ["The art of noticing", "https://www.are.na/", "A little inspiration for looking at everyday things a little differently.", "design", "Editorial", "Slow living", "noticing"],
    ["A quieter kind of internet", "https://www.figma.com/blog/", "Thoughtful spaces, meaningful connections, and making room for what matters.", "design", "Design", "Reading", "quiet"],
    ["Small details, big difference", "https://developer.mozilla.org/en-US/docs/Web/Accessibility", "An evergreen field guide to building a web that works for everyone.", "development", "Development", "Reference", "details"],
    ["Find your next adventure", "https://www.nationalgeographic.com/travel", "Places to wander. Stories to collect. A reminder to take the scenic route.", "travel", "Travel", "Inspiration", "adventure"],
    ["Good things take practice", "https://react.dev/learn", "Notes on learning, experimenting, and getting a little better every day.", "development", "Development", "Learning", "practice"],
    ["A place for your ideas", "https://www.notion.com/", "Gather the scattered bits. Make unexpected connections. Start something.", "unsorted", "Tools", "Inspiration", "ideas"]
  ];
  return { rootId: "demo-root", assetsId: "demo-assets", unsortedId: "unsorted", syncedAt: date,
    collections: [
      { id: "unsorted", parentId: "demo-root", name: "Unsorted", order: 0, view: "grid", system: "unsorted" },
      { id: "design", parentId: "demo-root", name: "Design inspiration", color: "#e4a464", order: 1, view: "grid" },
      { id: "editorial", parentId: "design", name: "Editorial & typography", color: "#d08a80", order: 0, view: "grid" },
      { id: "development", parentId: "demo-root", name: "Development", color: "#759284", order: 2, view: "grid" },
      { id: "travel", parentId: "demo-root", name: "Places to go", color: "#7c91b3", order: 3, view: "grid" }
    ],
    bookmarks: examples.map(([title, url, description, parentId, tag, tag2, cover], i) => ({ schemaVersion: 1, id: `demo-${i}`, title, url, description, note: i === 0 ? "Look for the small moments. They tend to be the ones worth keeping." : "", parentId, tags: [tag, tag2], demoCover: `/covers/${cover}.svg`, version: "1", modifiedTime: date }))
  };
}
