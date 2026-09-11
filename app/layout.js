export const metadata = {
  title: 'GRIPS',
  description: 'Pakistan-focused GIS, remote sensing & earth science research finder',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
