/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        apple: {
          canvas: 'var(--bg-canvas)',
          window: 'var(--bg-window)',
          card: 'var(--bg-card)',
          grouped: 'var(--bg-grouped)',
          hover: 'var(--bg-hover)',
          label: 'var(--label-primary)',
          secondary: 'var(--label-secondary)',
          tertiary: 'var(--label-tertiary)',
          separator: 'var(--separator)',
          blue: 'var(--apple-blue)',
          green: 'var(--apple-green)',
          orange: 'var(--apple-orange)',
          red: 'var(--apple-red)',
          pink: 'var(--apple-pink)',
          teal: 'var(--apple-teal)',
          indigo: 'var(--apple-indigo)',
        },
      },
      boxShadow: {
        'apple-card': 'var(--shadow-card)',
        'apple-popover': 'var(--shadow-popover)',
        'apple-sheet': 'var(--shadow-sheet)',
      },
    },
  },
  plugins: [],
};
