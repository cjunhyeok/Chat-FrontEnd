import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { login } from "../api/memberApi";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const { signin } = useAuth();
  const location = useLocation();

  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleLogin = async () => {
    if (!form.username.trim() || !form.password.trim()) {
      setError("아이디와 비밀번호를 입력해주세요.");
      return;
    }

    setError("");
    setLoading(true);

    try {
      const result = await login(form.username, form.password);
      signin(result.data.memberId, result.data.nickname);
    } catch (err) {
      const message = err.response?.data?.message;
      setError(message || "로그인 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleLogin();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center orbit-workspace">
      <div className="w-80 flex flex-col gap-4 bg-orbit-elevated rounded-2xl p-8 orbit-panel-bg">
        <h1 className="text-xl font-semibold text-orbit-text text-center mb-4">
          로그인
        </h1>

        <input
          type="text"
          name="username"
          placeholder="아이디"
          value={form.username}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="orbit-input w-full px-4 py-3"
        />

        <input
          type="password"
          name="password"
          placeholder="비밀번호"
          value={form.password}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="orbit-input w-full px-4 py-3"
        />

        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}

        <button
          onClick={handleLogin}
          disabled={loading}
          className="w-full py-3 bg-orbit-cyan hover:bg-orbit-cyan/80 disabled:bg-orbit-elevated disabled:text-orbit-muted disabled:cursor-not-allowed text-orbit-bg font-semibold rounded-lg transition-colors"
        >
          {loading ? "로그인 중..." : "로그인"}
        </button>

        <Link
          to="/signup"
          state={location.state?.from ? { from: location.state.from } : undefined}
          className="text-center text-orbit-muted hover:text-orbit-text text-sm transition-colors"
        >
          계정이 없으신가요? 회원가입
        </Link>
      </div>
    </div>
  );
}
