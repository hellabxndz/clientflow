import { redirect } from "next/navigation";
import { getAuth } from "@/lib/session";

export default async function Home() {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  redirect(auth.role === "client" ? "/portal" : "/app");
}
