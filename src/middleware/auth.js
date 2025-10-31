'use strict';

function ensureAuth(req, res, next) {
  if (!req.session?.token) return res.redirect('/login');
  next();
}

function ensureAdmin(req, res, next) {
  const role = req.session?.user?.role;
  if (role !== 'Admin') {
    res.locals.flash = res.locals.flash || [];
    res.locals.flash.push({ type: 'warning', message: 'Ação restrita a Admin.' });
    return res.redirect('back');
  }
  next();
}

function injectUser(req, res, next) {
  res.locals.currentUser = req.session?.user || null;
  next();
}

module.exports = { ensureAuth, ensureAdmin, injectUser };


