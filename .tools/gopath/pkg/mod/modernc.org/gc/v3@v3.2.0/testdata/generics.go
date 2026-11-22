// Copyright 2026 The Gc Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

// Generic type aliases (Go 1.24) and generic methods (Go 1.27).

package p

type T struct{}

// Generic methods: MethodDecl = "func" Receiver MethodName [ TypeParameters ] Signature [ FunctionBody ] .

func (T) m[P any](x P) P { return x }

func (t *T) f[P comparable, Q any](p P, q Q) bool { return any(p) == any(q) }

type List[E any] []E

func (l List[E]) apply[P any](f func(E) P) List[P] {
	r := make(List[P], len(l))
	for i, x := range l {
		r[i] = f(x)
	}
	return r
}

func (S[A, B]) n[C, D any]() {}

type S[A, B any] struct{}

func _() {
	var x T
	var _ int = x.m[int](1)
	var _ int = x.m(2)
	_ = List[int]{1, 2, 3}.apply[string](nil)

	// Explicit instantiation with multiple type arguments and with type
	// arguments that are not valid expressions.
	S[int, string]{}.n[bool, rune]()
	x.m[[]int](nil)
	x.m[map[int]string](nil)
	f := S[int, string]{}.n[bool, rune]
	f()
	var s S[int, string]
	s.n[[]int, [4]int,]()
}

// Generic type aliases: AliasDecl = identifier [ TypeParameters ] "=" Type .

type _ = int
type _[P any] = int
type _[P any, Q ~int] = map[Q]P
type _[P any, Q comparable, R any] = func(P, Q) R
type A[P any] = List[P]
type B[P interface{ ~[]int | ~string }] = List[P]
type C[P any,] = P

// Array/alias disambiguation must keep working.

const n = 4

type A1 [n]int
type A2 [4]int
type A3 []int
type A4 = [n]int
type A5 [n][n]int
