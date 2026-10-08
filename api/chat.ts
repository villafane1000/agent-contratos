import { manejarChat } from "../src/http.js";

export async function POST(req: Request) {
  return manejarChat(req);
}
