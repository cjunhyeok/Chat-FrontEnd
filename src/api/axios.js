import axios from "axios";

const axiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || "",
  withCredentials: true,
});

axiosInstance.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error.response?.status;
    if (status === 401) {
      sessionStorage.removeItem("memberId");
      sessionStorage.removeItem("nickname");
      window.location.href = "/";
    }
    return Promise.reject(error);
  }
);

export default axiosInstance;
