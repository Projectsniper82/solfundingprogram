/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@jup-ag/core",
    "@jup-ag/react-hook",
    "@solana/web3.js",
    "@solana/wallet-adapter-react",
    "@solana/wallet-adapter-wallets",
    "@solana/wallet-adapter-base",
    "@solana/wallet-adapter-react-ui"
  ]
};

module.exports = nextConfig;

