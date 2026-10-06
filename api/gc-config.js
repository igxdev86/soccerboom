module.exports = (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json({ url: process.env.SUPABASE_URL || null, anon: process.env.SUPABASE_ANON_KEY || null });
};
