import AuthForm from "@/components/AuthForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ registered?: string; u?: string }>;
}) {
  const { registered, u } = await searchParams;
  return (
    <AuthForm
      mode="login"
      registered={registered === "1"}
      initialUsername={typeof u === "string" ? u : ""}
    />
  );
}
