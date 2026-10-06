import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f6f3ff",
          100: "#ede8ff",
          200: "#ddd3ff",
          300: "#c4b2fd",
          400: "#a688fa",
          500: "#8b5cf6",
          600: "#7647e8",
          700: "#6335c9",
          800: "#522ea3",
          900: "#442a82",
        },
        ink: {
          900: "#16131f",
          800: "#2a2535",
          700: "#3b3649",
          600: "#544e63",
          500: "#6b6579",
          400: "#8c879a",
          300: "#b9b5c4",
          200: "#e4e1ea",
          100: "#f1eff5",
          50: "#f9f8fb",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(22,19,31,0.04), 0 1px 3px rgba(22,19,31,0.06)",
      },
    },
  },
  plugins: [],
} satisfies Config;
