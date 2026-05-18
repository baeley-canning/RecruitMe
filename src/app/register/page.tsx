"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Users, CheckCircle2, Loader2 } from "lucide-react";

type Step = "org" | "account" | "done";

interface FormState {
  orgName: string;
  username: string;
  password: string;
  confirmPassword: string;
}

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("org");
  const [form, setForm] = useState<FormState>({
    orgName: "",
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const updateField = (field: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, [field]: e.target.value }));
    setError("");
  };

  const handleOrgStep = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.orgName.trim()) {
      setError("Organisation name is required");
      return;
    }
    setStep("account");
  };

  const handleAccountStep = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username.trim() || !form.password) {
      setError("Username and password are required");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (form.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgName: form.orgName,
          username: form.username,
          password: form.password,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : "Registration failed");
        return;
      }

      // Auto sign-in
      const result = await signIn("credentials", {
        username: form.username,
        password: form.password,
        redirect: false,
      });

      if (result?.ok) {
        setStep("done");
        setTimeout(() => router.push("/dashboard"), 1500);
      } else {
        setStep("done");
      }
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        {/* Logo */}
        <div className="flex items-center gap-2 justify-center">
          <Users className="w-6 h-6 text-accent" />
          <span className="font-semibold text-lg text-foreground">RecruitMe</span>
        </div>

        {step === "done" ? (
          <div className="text-center space-y-4 py-8">
            <CheckCircle2 className="w-12 h-12 text-success mx-auto" />
            <h1 className="text-xl font-semibold text-foreground">You&apos;re all set!</h1>
            <p className="text-sm text-muted-foreground">Signing you in…</p>
          </div>
        ) : (
          <div className="border border-border rounded-xl p-6 space-y-5 bg-card">
            {/* Step indicator */}
            <div className="flex items-center gap-2">
              <div className={`h-1 flex-1 rounded-full ${step === "org" || step === "account" ? "bg-accent" : "bg-border"}`} />
              <div className={`h-1 flex-1 rounded-full ${step === "account" ? "bg-accent" : "bg-border"}`} />
            </div>

            {step === "org" && (
              <>
                <div>
                  <h1 className="text-lg font-semibold text-foreground">Create your account</h1>
                  <p className="text-sm text-muted-foreground mt-1">Step 1: Your organisation</p>
                </div>

                <form onSubmit={handleOrgStep} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="orgName">
                      Organisation name
                    </label>
                    <input
                      id="orgName"
                      type="text"
                      autoFocus
                      value={form.orgName}
                      onChange={updateField("orgName")}
                      placeholder="Acme Recruitment Ltd"
                      className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>

                  {error && <p className="text-sm text-danger">{error}</p>}

                  <button
                    type="submit"
                    className="w-full bg-accent text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-accent/90 transition-colors"
                  >
                    Continue
                  </button>
                </form>
              </>
            )}

            {step === "account" && (
              <>
                <div>
                  <h1 className="text-lg font-semibold text-foreground">Create your account</h1>
                  <p className="text-sm text-muted-foreground mt-1">Step 2: Your login credentials</p>
                </div>

                <form onSubmit={handleAccountStep} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="username">
                      Username
                    </label>
                    <input
                      id="username"
                      type="text"
                      autoFocus
                      value={form.username}
                      onChange={updateField("username")}
                      placeholder="jane.smith"
                      className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="password">
                      Password
                    </label>
                    <input
                      id="password"
                      type="password"
                      value={form.password}
                      onChange={updateField("password")}
                      placeholder="At least 8 characters"
                      className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1" htmlFor="confirmPassword">
                      Confirm password
                    </label>
                    <input
                      id="confirmPassword"
                      type="password"
                      value={form.confirmPassword}
                      onChange={updateField("confirmPassword")}
                      placeholder="Repeat password"
                      className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-accent/50"
                    />
                  </div>

                  {error && <p className="text-sm text-danger">{error}</p>}

                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setStep("org"); setError(""); }}
                      className="flex-1 border border-border rounded-md px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
                    >
                      Back
                    </button>
                    <button
                      type="submit"
                      disabled={loading}
                      className="flex-1 bg-accent text-white rounded-md px-4 py-2 text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      Create account
                    </button>
                  </div>
                </form>
              </>
            )}

            <p className="text-xs text-center text-muted-foreground">
              Already have an account?{" "}
              <Link href="/login" className="text-accent hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
