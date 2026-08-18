// Blotato publishing stub. Deliberately NOT implemented: it logs what it was
// asked to publish and throws, so any premature call fails loudly instead of
// silently pretending content went out. BLOTATO_API_KEY is already in the
// environment contract (.env.example / render.yaml) for when this is built.

export async function publishContent(payload: object): Promise<void> {
  console.log("[blotato] publishContent called with payload:", JSON.stringify(payload));
  throw new Error("not implemented");
}
