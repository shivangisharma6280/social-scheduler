import axios from "axios";

const api = axios.create({
    baseURL: "https://social-scheduler-backend-byp9.onrender.com"
})

export default api;
