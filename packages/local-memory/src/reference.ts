// Offline Programming Reference: static notes bundled with the browser and
// searched locally. This is documentation, not an AI model.
export interface RefEntry {
  id: string;
  lang: 'Python' | 'Java' | 'C' | 'C++' | 'JavaScript' | 'Data structures' | 'Errors' | 'Examples';
  title: string;
  keywords: string;
  body: string;
}

const e = (id: string, lang: RefEntry['lang'], title: string, keywords: string, body: string): RefEntry => ({ id, lang, title, keywords, body: body.trim() });

export const REFERENCE: RefEntry[] = [
  // ------------------------------------------------------------ Python
  e('py-basics', 'Python', 'Variables, types and printing', 'python variable int float str bool print input f-string type', `
Python decides the type from the value. No semicolons, blocks are indented.

\`\`\`python
name = "Asha"          # str
age = 19               # int
height = 1.62          # float
is_student = True      # bool
print(f"{name} is {age} years old")
age = int(input("Age: "))   # input() always returns a string
print(type(age))            # <class 'int'>
\`\`\`
`),
  e('py-control', 'Python', 'if, for, while', 'python if elif else for while range break continue loop', `
\`\`\`python
marks = 72
if marks >= 90:
    grade = "A"
elif marks >= 60:
    grade = "B"
else:
    grade = "C"

for i in range(5):        # 0 1 2 3 4
    print(i)
for i in range(2, 10, 2): # 2 4 6 8
    print(i)

n = 3
while n > 0:
    n -= 1
\`\`\`
\`break\` leaves the loop, \`continue\` skips to the next round.
`),
  e('py-functions', 'Python', 'Functions', 'python def return default argument lambda *args **kwargs function', `
\`\`\`python
def area(width, height=1):
    """Return the area of a rectangle."""
    return width * height

print(area(3, 4))      # 12
print(area(5))         # 5  (height defaults to 1)

square = lambda x: x * x

def total(*numbers):   # any number of arguments
    return sum(numbers)
\`\`\`
`),
  e('py-list', 'Python', 'Lists, tuples, slicing', 'python list append pop sort slice tuple len comprehension index', `
\`\`\`python
nums = [5, 2, 9]
nums.append(1)        # [5, 2, 9, 1]
nums.sort()           # [1, 2, 5, 9]
last = nums.pop()     # 9
print(nums[0], nums[-1], nums[1:3], len(nums))
squares = [n * n for n in nums if n > 1]   # list comprehension
point = (3, 4)        # tuple: cannot be changed
\`\`\`
`),
  e('py-dict', 'Python', 'Dictionaries and sets', 'python dict key value get items set in hash map', `
\`\`\`python
ages = {"asha": 19, "ravi": 21}
ages["mina"] = 20
print(ages.get("zed", 0))       # 0 when the key is missing
for name, age in ages.items():
    print(name, age)
if "asha" in ages:
    del ages["asha"]

seen = {1, 2, 3}
seen.add(2)                     # sets keep one copy of each value
\`\`\`
`),
  e('py-strings', 'Python', 'String methods', 'python string split join strip upper lower replace find format', `
\`\`\`python
s = "  Hello, World  "
print(s.strip().lower())           # "hello, world"
words = "a,b,c".split(",")         # ['a', 'b', 'c']
print("-".join(words))             # a-b-c
print(s.replace("World", "Raven"))
print("lo" in s, s.find("W"))      # True 9
print(s[::-1])                     # reversed
\`\`\`
`),
  e('py-class', 'Python', 'Classes and objects', 'python class object __init__ self method inheritance super', `
\`\`\`python
class Animal:
    def __init__(self, name):
        self.name = name
    def speak(self):
        return f"{self.name} makes a sound"

class Dog(Animal):
    def speak(self):
        return f"{self.name} says woof"

d = Dog("Rex")
print(d.speak())
\`\`\`
`),
  e('py-files', 'Python', 'Files and exceptions', 'python open read write file with try except finally error handling', `
\`\`\`python
with open("notes.txt", "w") as f:    # closes the file by itself
    f.write("first line\\n")

try:
    with open("notes.txt") as f:
        for line in f:
            print(line.strip())
except FileNotFoundError:
    print("no such file")
except Exception as err:
    print("something else:", err)
\`\`\`
`),
  e('py-recursion', 'Python', 'Recursion', 'python recursion factorial fibonacci base case recursive', `
A function that calls itself. It needs a base case that stops it.

\`\`\`python
def factorial(n):
    if n <= 1:            # base case
        return 1
    return n * factorial(n - 1)

def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)

print(factorial(5))   # 120
\`\`\`
Too many nested calls raises RecursionError (default limit about 1000).
`),

  // ------------------------------------------------------------ Java
  e('java-basics', 'Java', 'Program structure and types', 'java main class public static void int double String boolean System.out.println', `
Every program lives in a class. The file name matches the public class.

\`\`\`java
public class Main {
    public static void main(String[] args) {
        int age = 19;
        double height = 1.62;
        boolean student = true;
        String name = "Asha";
        System.out.println(name + " is " + age);
    }
}
\`\`\`
Compile: \`javac Main.java\`  Run: \`java Main\`
`),
  e('java-control', 'Java', 'if, switch, loops', 'java if else switch for while do break continue enhanced for', `
\`\`\`java
if (marks >= 90) grade = 'A';
else if (marks >= 60) grade = 'B';
else grade = 'C';

for (int i = 0; i < 5; i++) System.out.println(i);

int[] nums = {4, 8, 15};
for (int n : nums) System.out.println(n);   // for-each

int k = 3;
while (k > 0) k--;
\`\`\`
`),
  e('java-arrays', 'Java', 'Arrays and ArrayList', 'java array length ArrayList add get size List generics', `
\`\`\`java
int[] a = new int[5];        // fixed size, filled with 0
a[0] = 7;
System.out.println(a.length);

import java.util.ArrayList;
ArrayList<String> names = new ArrayList<>();
names.add("Asha");
names.add("Ravi");
System.out.println(names.get(0) + " " + names.size());
names.remove("Ravi");
\`\`\`
`),
  e('java-class', 'Java', 'Classes, objects, inheritance', 'java class object constructor this extends super override interface implements', `
\`\`\`java
class Animal {
    protected String name;
    Animal(String name) { this.name = name; }
    String speak() { return name + " makes a sound"; }
}
class Dog extends Animal {
    Dog(String name) { super(name); }
    @Override String speak() { return name + " says woof"; }
}
Animal d = new Dog("Rex");
System.out.println(d.speak());
\`\`\`
An \`interface\` lists methods a class promises to have: \`class Cat implements Pet { ... }\`.
`),
  e('java-strings', 'Java', 'Strings', 'java String equals length charAt substring StringBuilder compare', `
\`\`\`java
String s = "Hello";
s.length();            // 5
s.charAt(0);           // 'H'
s.substring(1, 3);     // "el"
s.equals("Hello");     // compare text with equals(), not ==
s.toUpperCase();
StringBuilder sb = new StringBuilder();
sb.append("a").append(1);   // fast way to build text in a loop
\`\`\`
`),
  e('java-exceptions', 'Java', 'Exceptions and input', 'java try catch finally throw Scanner input nextInt exception', `
\`\`\`java
import java.util.Scanner;
Scanner in = new Scanner(System.in);
try {
    int n = in.nextInt();
    System.out.println(10 / n);
} catch (ArithmeticException ex) {
    System.out.println("cannot divide by zero");
} finally {
    in.close();
}
\`\`\`
`),

  // ------------------------------------------------------------ C
  e('c-basics', 'C', 'Program structure, printf, scanf', 'c main include stdio printf scanf int float char format specifier', `
\`\`\`c
#include <stdio.h>

int main(void) {
    int age;
    float height = 1.62f;
    char grade = 'A';
    printf("Enter age: ");
    scanf("%d", &age);                 /* & gives scanf the address */
    printf("%d %.2f %c\\n", age, height, grade);
    return 0;
}
\`\`\`
Format codes: \`%d\` int, \`%f\` float/double, \`%c\` char, \`%s\` string, \`%p\` pointer.
Compile: \`gcc main.c -o main\`
`),
  e('c-pointers', 'C', 'Pointers', 'c pointer address dereference * & NULL pass by reference swap', `
A pointer stores the address of another variable.

\`\`\`c
int x = 10;
int *p = &x;        /* p holds the address of x */
*p = 20;            /* change x through the pointer */

void swap(int *a, int *b) {
    int t = *a; *a = *b; *b = t;
}
swap(&x, &y);
\`\`\`
Never use a pointer that was not set (set it to \`NULL\` and check before use).
`),
  e('c-arrays', 'C', 'Arrays and strings', 'c array string char strlen strcpy strcmp null terminator index', `
\`\`\`c
int nums[5] = {1, 2, 3};      /* the rest are 0 */
for (int i = 0; i < 5; i++) printf("%d ", nums[i]);

#include <string.h>
char name[20] = "Asha";       /* ends with a hidden '\\0' */
printf("%zu\\n", strlen(name));
strcpy(name, "Ravi");
if (strcmp(name, "Ravi") == 0) puts("same");
\`\`\`
C does not check array bounds. Writing past the end corrupts memory.
`),
  e('c-struct', 'C', 'Structures', 'c struct typedef member arrow operator -> dot', `
\`\`\`c
typedef struct {
    char name[30];
    int age;
} Student;

Student s = {"Asha", 19};
printf("%s %d\\n", s.name, s.age);

Student *p = &s;
p->age = 20;          /* same as (*p).age */
\`\`\`
`),
  e('c-malloc', 'C', 'Dynamic memory: malloc and free', 'c malloc calloc realloc free heap memory leak sizeof', `
\`\`\`c
#include <stdlib.h>

int *a = malloc(n * sizeof(int));
if (a == NULL) return 1;        /* always check */
for (int i = 0; i < n; i++) a[i] = i;
a = realloc(a, 2 * n * sizeof(int));
free(a);                         /* one free for every malloc */
a = NULL;
\`\`\`
Forgetting \`free\` is a memory leak. Using memory after \`free\` is a bug.
`),
  e('c-linked-list', 'C', 'Linked list in C', 'c linked list node insert delete traverse struct next malloc', `
\`\`\`c
#include <stdio.h>
#include <stdlib.h>

typedef struct Node { int data; struct Node *next; } Node;

Node *push_front(Node *head, int v) {
    Node *n = malloc(sizeof(Node));
    n->data = v; n->next = head;
    return n;
}
void print(Node *head) {
    for (Node *p = head; p != NULL; p = p->next) printf("%d -> ", p->data);
    puts("NULL");
}
void free_list(Node *head) {
    while (head) { Node *t = head; head = head->next; free(t); }
}
int main(void) {
    Node *head = NULL;
    head = push_front(head, 3);
    head = push_front(head, 2);
    head = push_front(head, 1);
    print(head);              /* 1 -> 2 -> 3 -> NULL */
    free_list(head);
    return 0;
}
\`\`\`
`),

  // ------------------------------------------------------------ C++
  e('cpp-basics', 'C++', 'Program structure, cout, cin', 'c++ cpp iostream cout cin std namespace main string', `
\`\`\`cpp
#include <iostream>
#include <string>
using namespace std;

int main() {
    string name;
    int age;
    cout << "Name and age: ";
    cin >> name >> age;
    cout << name << " is " << age << endl;
    return 0;
}
\`\`\`
Compile: \`g++ main.cpp -o main\`
`),
  e('cpp-vector', 'C++', 'vector, map, range-for', 'c++ vector push_back size map sort algorithm auto iterator', `
\`\`\`cpp
#include <vector>
#include <map>
#include <algorithm>

vector<int> v = {5, 2, 9};
v.push_back(1);
sort(v.begin(), v.end());
for (int x : v) cout << x << " ";

map<string, int> ages;
ages["asha"] = 19;
for (auto &[name, age] : ages) cout << name << " " << age << "\\n";
\`\`\`
`),
  e('cpp-class', 'C++', 'Classes', 'c++ class public private constructor destructor member function virtual inheritance', `
\`\`\`cpp
class Animal {
protected:
    string name;
public:
    Animal(string n) : name(n) {}
    virtual string speak() { return name + " makes a sound"; }
    virtual ~Animal() {}
};
class Dog : public Animal {
public:
    Dog(string n) : Animal(n) {}
    string speak() override { return name + " says woof"; }
};
\`\`\`
\`virtual\` lets a base pointer call the derived version.
`),
  e('cpp-refs', 'C++', 'References, new/delete, smart pointers', 'c++ reference & new delete unique_ptr shared_ptr memory', `
\`\`\`cpp
void addOne(int &n) { n++; }      // reference: changes the caller's variable

int *p = new int(5);
delete p;                          // every new needs a delete

#include <memory>
auto q = make_unique<int>(5);      // frees itself, preferred
\`\`\`
`),

  // ------------------------------------------------------------ JavaScript
  e('js-basics', 'JavaScript', 'Variables and types', 'javascript js let const var number string boolean null undefined typeof template', `
\`\`\`js
const name = "Asha";     // cannot be reassigned
let age = 19;            // can change
age += 1;
console.log(\`\${name} is \${age}\`);
console.log(typeof age);       // "number"
console.log(1 === "1");        // false: use === (no type conversion)
\`\`\`
`),
  e('js-functions', 'JavaScript', 'Functions and arrow functions', 'javascript function arrow => callback default parameter return', `
\`\`\`js
function area(w, h = 1) { return w * h; }
const square = (x) => x * x;
const greet = (name) => {
  const msg = "Hi " + name;
  return msg;
};
[1, 2, 3].forEach((n) => console.log(square(n)));
\`\`\`
`),
  e('js-arrays', 'JavaScript', 'Arrays and objects', 'javascript array push map filter reduce find object key spread destructuring', `
\`\`\`js
const nums = [5, 2, 9];
nums.push(1);
const doubled = nums.map((n) => n * 2);
const big = nums.filter((n) => n > 3);
const total = nums.reduce((sum, n) => sum + n, 0);

const user = { name: "Asha", age: 19 };
const { name, age } = user;          // destructuring
const copy = { ...user, age: 20 };   // spread
\`\`\`
`),
  e('js-dom', 'JavaScript', 'DOM and events', 'javascript dom document querySelector addEventListener click innerText html', `
\`\`\`html
<button id="go">Click</button>
<p id="out"></p>
<script>
  const out = document.querySelector("#out");
  document.querySelector("#go").addEventListener("click", () => {
    out.textContent = "Clicked at " + new Date().toLocaleTimeString();
  });
</script>
\`\`\`
`),
  e('js-async', 'JavaScript', 'Promises, async/await, fetch', 'javascript promise async await fetch then catch json api', `
\`\`\`js
async function load() {
  try {
    const res = await fetch("https://example.com/data.json");
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    console.log(data);
  } catch (err) {
    console.error("failed:", err.message);
  }
}
\`\`\`
\`await\` only works inside an \`async\` function (or at the top of a module).
`),

  // ------------------------------------------------------------ Data structures
  e('ds-array-list', 'Data structures', 'Array vs linked list', 'array linked list compare access insert delete complexity big o', `
| | Array | Linked list |
|---|---|---|
| Read item i | O(1) | O(n) |
| Insert/delete at front | O(n) | O(1) |
| Insert/delete at end | O(1) amortised | O(1) with tail pointer |
| Memory | one block | a node per item, plus a pointer |

Use an array when you index a lot. Use a linked list when you insert and remove at the ends a lot.
`),
  e('ds-stack-queue', 'Data structures', 'Stack and queue', 'stack queue push pop lifo fifo enqueue dequeue', `
**Stack**: last in, first out. \`push\` adds on top, \`pop\` removes the top. Used for undo, function calls, bracket matching.

**Queue**: first in, first out. \`enqueue\` at the back, \`dequeue\` from the front. Used for scheduling and breadth-first search.

\`\`\`python
stack = []
stack.append(1); stack.append(2)
stack.pop()            # 2

from collections import deque
q = deque()
q.append(1); q.append(2)
q.popleft()            # 1
\`\`\`
`),
  e('ds-bst', 'Data structures', 'Binary search tree', 'binary search tree bst insert search inorder traversal node left right', `
Each node has up to two children. Everything in the left subtree is smaller, everything in the right subtree is larger. Search, insert and delete take O(log n) when the tree is balanced, O(n) in the worst case (a tree that became a line).

\`\`\`python
class Node:
    def __init__(self, key):
        self.key, self.left, self.right = key, None, None

def insert(root, key):
    if root is None:
        return Node(key)
    if key < root.key:
        root.left = insert(root.left, key)
    else:
        root.right = insert(root.right, key)
    return root

def inorder(root):          # visits keys in sorted order
    if root:
        inorder(root.left); print(root.key); inorder(root.right)
\`\`\`
`),
  e('ds-hash', 'Data structures', 'Hash table', 'hash table map dictionary collision bucket key value o(1)', `
Stores key → value. A hash function turns the key into an array position, so lookups are O(1) on average. Two keys landing on the same position is a collision; it is handled with a list per position (chaining) or by trying the next free slot (open addressing).

Python \`dict\`, Java \`HashMap\`, C++ \`unordered_map\`, JavaScript \`Map\` are hash tables.
`),
  e('ds-binary-search', 'Data structures', 'Binary search', 'binary search sorted array algorithm log n mid low high', `
Finds a value in a **sorted** array by halving the range each step: O(log n).

\`\`\`python
def binary_search(a, target):
    lo, hi = 0, len(a) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if a[mid] == target:
            return mid
        if a[mid] < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1
\`\`\`
`),
  e('ds-sorting', 'Data structures', 'Sorting algorithms', 'sort bubble selection insertion merge quick sort complexity stable', `
| Algorithm | Average | Worst | Notes |
|---|---|---|---|
| Bubble | O(n²) | O(n²) | simple, slow |
| Insertion | O(n²) | O(n²) | fast on nearly sorted data |
| Merge | O(n log n) | O(n log n) | stable, needs extra memory |
| Quick | O(n log n) | O(n²) | fast in practice, in place |

\`\`\`python
def bubble_sort(a):
    for i in range(len(a)):
        for j in range(len(a) - 1 - i):
            if a[j] > a[j + 1]:
                a[j], a[j + 1] = a[j + 1], a[j]
\`\`\`
`),
  e('ds-bigo', 'Data structures', 'Big-O in one table', 'big o complexity time space constant linear logarithmic quadratic', `
| Name | Big-O | Example |
|---|---|---|
| Constant | O(1) | read array[i] |
| Logarithmic | O(log n) | binary search |
| Linear | O(n) | one loop over the data |
| Linearithmic | O(n log n) | merge sort |
| Quadratic | O(n²) | two nested loops |
| Exponential | O(2ⁿ) | naive recursive fibonacci |
`),
  e('ds-graph', 'Data structures', 'Graphs: BFS and DFS', 'graph bfs dfs breadth depth first search adjacency list visited', `
\`\`\`python
from collections import deque
graph = {"A": ["B", "C"], "B": ["D"], "C": ["D"], "D": []}

def bfs(start):                 # level by level, uses a queue
    seen, q = {start}, deque([start])
    while q:
        node = q.popleft()
        print(node)
        for nxt in graph[node]:
            if nxt not in seen:
                seen.add(nxt); q.append(nxt)

def dfs(node, seen=None):       # go deep first, uses recursion (a stack)
    seen = seen or set()
    seen.add(node); print(node)
    for nxt in graph[node]:
        if nxt not in seen:
            dfs(nxt, seen)
\`\`\`
`),

  // ------------------------------------------------------------ Common errors
  e('err-python', 'Errors', 'Common Python errors', 'python error IndentationError NameError TypeError IndexError KeyError SyntaxError ValueError AttributeError', `
- **IndentationError**: lines in one block must be indented the same. Do not mix tabs and spaces.
- **NameError: name 'x' is not defined**: spelling mistake, or the variable is used before it is set.
- **TypeError: can only concatenate str (not "int") to str**: convert first, \`"Age: " + str(age)\`.
- **IndexError: list index out of range**: the last valid index is \`len(a) - 1\`.
- **KeyError**: the dictionary has no such key; use \`d.get(key)\`.
- **ValueError: invalid literal for int()**: the text is not a number.
- **AttributeError: 'NoneType' object has no attribute**: a function returned \`None\` (often a missing \`return\`).
`),
  e('err-java', 'Errors', 'Common Java errors', 'java error NullPointerException ArrayIndexOutOfBounds cannot find symbol missing return incompatible types ClassNotFound', `
- **NullPointerException**: you called a method on a variable that is \`null\`. Create the object first.
- **ArrayIndexOutOfBoundsException**: valid indexes are 0 to \`length - 1\`.
- **cannot find symbol**: misspelled name, missing import, or variable declared in another block.
- **incompatible types: possible lossy conversion from double to int**: cast it, \`(int) value\`.
- **missing return statement**: every path of a non-void method must return.
- **class X is public, should be declared in a file named X.java**: rename the file.
- Comparing strings with \`==\` compares references; use \`.equals()\`.
`),
  e('err-c', 'Errors', 'Common C and C++ errors', 'c c++ error segmentation fault segfault undefined reference implicit declaration dangling pointer buffer overflow uninitialized', `
- **Segmentation fault**: reading or writing memory you do not own. Check array indexes, NULL pointers, and missing \`&\` in \`scanf\`.
- **undefined reference to 'f'**: the function is declared but never defined, or a file/library is missing from the compile command.
- **implicit declaration of function**: missing \`#include\` or the function is used before it is declared.
- **Uninitialized variable**: local variables hold garbage until you assign them.
- **Buffer overflow**: writing past the end of an array, often with \`strcpy\` or \`gets\`. Use sizes.
- \`=\` assigns, \`==\` compares. \`if (x = 5)\` is always true.
- Missing semicolon after a \`struct\`/\`class\` definition.
`),
  e('err-js', 'Errors', 'Common JavaScript errors', 'javascript error undefined is not a function cannot read properties of undefined ReferenceError SyntaxError NaN CORS', `
- **TypeError: Cannot read properties of undefined (reading 'x')**: the object before \`.x\` is undefined. Log it, or use \`obj?.x\`.
- **ReferenceError: x is not defined**: misspelled or out of scope.
- **x is not a function**: the name holds something else, or the script loaded before the function existed.
- **NaN**: maths on something that is not a number; convert with \`Number(text)\`.
- **Unexpected token**: a missing bracket, quote or comma just before that spot.
- \`==\` converts types (\`"1" == 1\` is true). Prefer \`===\`.
- Code that needs an element must run after the page has loaded.
`),

  // ------------------------------------------------------------ Examples
  e('ex-html-login', 'Examples', 'HTML login page', 'html css login form page input password button example', `
\`\`\`html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Login</title>
<style>
  body { font-family: system-ui; display: grid; place-items: center; height: 100vh; margin: 0; background: #f2f2f2; }
  form { background: #fff; padding: 24px; border-radius: 8px; width: 280px; box-shadow: 0 4px 20px rgba(0,0,0,.1); }
  input, button { width: 100%; padding: 10px; margin-top: 10px; box-sizing: border-box; }
  button { background: #eb4604; color: #fff; border: 0; cursor: pointer; }
</style>
</head>
<body>
  <form onsubmit="event.preventDefault(); alert('Submitted');">
    <h2>Sign in</h2>
    <input type="email" placeholder="Email" required>
    <input type="password" placeholder="Password" required minlength="6">
    <button type="submit">Login</button>
  </form>
</body>
</html>
\`\`\`
`),
  e('ex-js-calculator', 'Examples', 'JavaScript calculator', 'javascript calculator html example add subtract multiply divide', `
\`\`\`html
<input id="a" type="number"> <select id="op"><option>+</option><option>-</option><option>*</option><option>/</option></select>
<input id="b" type="number"> <button id="eq">=</button> <span id="out"></span>
<script>
  document.getElementById("eq").onclick = () => {
    const a = Number(document.getElementById("a").value);
    const b = Number(document.getElementById("b").value);
    const op = document.getElementById("op").value;
    const r = op === "+" ? a + b : op === "-" ? a - b : op === "*" ? a * b : b === 0 ? "cannot divide by 0" : a / b;
    document.getElementById("out").textContent = r;
  };
</script>
\`\`\`
`),
  e('ex-prime', 'Examples', 'Prime number check (Python, C, Java)', 'prime number check example python c java loop', `
\`\`\`python
def is_prime(n):
    if n < 2:
        return False
    i = 2
    while i * i <= n:
        if n % i == 0:
            return False
        i += 1
    return True
\`\`\`
\`\`\`c
int is_prime(int n) {
    if (n < 2) return 0;
    for (int i = 2; i * i <= n; i++) if (n % i == 0) return 0;
    return 1;
}
\`\`\`
\`\`\`java
static boolean isPrime(int n) {
    if (n < 2) return false;
    for (int i = 2; (long) i * i <= n; i++) if (n % i == 0) return false;
    return true;
}
\`\`\`
`),
  e('ex-reverse', 'Examples', 'Reverse a string, palindrome check', 'reverse string palindrome example python java c javascript', `
\`\`\`python
s = "level"
print(s[::-1])
print(s == s[::-1])        # palindrome?
\`\`\`
\`\`\`java
String r = new StringBuilder(s).reverse().toString();
boolean pal = s.equals(r);
\`\`\`
\`\`\`js
const r = [...s].reverse().join("");
\`\`\`
\`\`\`c
void reverse(char *s) {
    for (int i = 0, j = strlen(s) - 1; i < j; i++, j--) { char t = s[i]; s[i] = s[j]; s[j] = t; }
}
\`\`\`
`),
  e('ex-file-count', 'Examples', 'Count words in a file (Python)', 'python file word count example dictionary read', `
\`\`\`python
from collections import Counter

with open("story.txt", encoding="utf-8") as f:
    words = f.read().lower().split()

counts = Counter(words)
for word, n in counts.most_common(10):
    print(f"{word:15} {n}")
\`\`\`
`),
];

export interface RefHit {
  entry: RefEntry;
  score: number;
}

/** Local keyword search over the bundled reference. No network, no model. */
export function searchReference(query: string, lang?: string): RefHit[] {
  const STOP = new Set(['in', 'the', 'for', 'of', 'to', 'how', 'an', 'is', 'with', 'and', 'on']);
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => (t.length > 1 || t === 'c') && !STOP.has(t));
  const out: RefHit[] = [];
  for (const entry of REFERENCE) {
    if (lang && lang !== 'All' && entry.lang !== lang) continue;
    if (terms.length === 0) {
      out.push({ entry, score: 1 });
      continue;
    }
    const title = entry.title.toLowerCase();
    const kwWords = entry.keywords.toLowerCase().split(' ');
    const body = entry.body.toLowerCase();
    const langName = entry.lang.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      let s = 0;
      if (langName === t || (t === 'cpp' && langName === 'c++') || (t === 'js' && langName === 'javascript')) s += 8;
      if (t.length > 1) {
        if (title.includes(t)) s += 5;
        if (kwWords.includes(t)) s += 4;
        else if (kwWords.some((k) => k.includes(t))) s += 2;
        if (langName.startsWith(t)) s += 2;
        if (body.includes(t)) s += 1;
      } else if (kwWords.includes(t)) s += 4;
      if (s === 0) all = false;
      score += s;
    }
    if (score > 0) out.push({ entry, score: all ? score + 6 : score });
  }
  return out.sort((a, b) => b.score - a.score);
}
