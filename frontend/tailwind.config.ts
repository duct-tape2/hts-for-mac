import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070b12",
          900: "#0d1420",
          800: "#141c2b",
          700: "#1c2738",
          600: "#243044",
        },
        cream: {
          50: "#e8eef6",
          100: "#c5ced9",
          300: "#8b98a8",
          500: "#6b7785",
        },
        brass: {
          400: "#e9b747",
          500: "#dca538",
        },
        up: "#f15b65",
        down: "#5695f7",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Apple SD Gothic Neo", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },

    },
  },
  plugins: [],
};

export default config;
