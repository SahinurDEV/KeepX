import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-5 py-24">
      <h1 className="font-serif text-4xl">That page is not here</h1>
      <Link className="mt-4 inline-block text-accent" href="/">
        Back to the start
      </Link>
    </div>
  );
}
