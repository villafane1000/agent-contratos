import { estado } from "../src/http.js";

export async function GET() {
  return estado();
}
