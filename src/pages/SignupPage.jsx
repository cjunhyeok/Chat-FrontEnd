import { useState } from "react";
import { useNavigate, Link, useLocation } from "react-router-dom";
import { signup } from "../api/memberApi";

export default function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({
    username: "",
    password: "",
    passwordConfirm: "",
    nickname: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const validate = () => {
    if (!form.username.trim()) return "아이디를 입력해주세요.";
    if (!form.password.trim()) return "비밀번호를 입력해주세요.";
    if (form.password !== form.passwordConfirm) return "비밀번호가 일치하지 않습니다.";
    if (!form.nickname.trim()) return "닉네임을 입력해주세요.";
    return "";
  };

  const handleSignup = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setError("");
    setLoading(true);

    try {
      await signup(form.username, form.password, form.nickname);
      navigate("/", {
        replace: true,
        state: location.state?.from ? { from: location.state.from } : undefined,
      });
    } catch (err) {
      const message = err.response?.data?.message;
      setError(message || "회원가입 중 오류가 발생했습니다.");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") handleSignup();
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center orbit-workspace">
      <div className="w-80 flex flex-col gap-4 bg-orbit-elevated rounded-2xl p-8 orbit-panel-bg">
        <h1 className="text-xl font-semibold text-orbit-text text-center mb-4">
          회원가입
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

        <input
          type="password"
          name="passwordConfirm"
          placeholder="비밀번호 확인"
          value={form.passwordConfirm}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="orbit-input w-full px-4 py-3"
        />

        <input
          type="text"
          name="nickname"
          placeholder="닉네임"
          value={form.nickname}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="orbit-input w-full px-4 py-3"
        />

        {error && (
          <p className="text-red-400 text-sm text-center">{error}</p>
        )}

        <button
          onClick={handleSignup}
          disabled={loading}
          className="w-full py-3 bg-orbit-cyan hover:bg-orbit-cyan/80 disabled:bg-orbit-elevated disabled:text-orbit-muted disabled:cursor-not-allowed text-orbit-bg font-semibold rounded-lg transition-colors"
        >
          {loading ? "처리 중..." : "회원가입"}
        </button>

        <Link
          to="/"
          state={location.state?.from ? { from: location.state.from } : undefined}
          className="text-center text-orbit-muted hover:text-orbit-text text-sm transition-colors"
        >
          이미 계정이 있으신가요? 로그인
        </Link>
      </div>
    </div>
  );
}
