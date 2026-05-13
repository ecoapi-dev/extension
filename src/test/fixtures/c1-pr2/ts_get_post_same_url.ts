export async function readUser(id: string) {
  const r = await fetch(`https://api.example.com/v1/users/${id}`);
  return r.json();
}

export async function writeUser(id: string, body: unknown) {
  const r = await fetch(`https://api.example.com/v1/users/${id}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return r.json();
}
