import { PolicyLayout, PolicyLinks } from '../../components/policies/policy-layout';

export const metadata = { title: 'Help & policies | Hive' };
export default function PoliciesPage() {
  return <PolicyLayout title="Hive policies" sections={[]}><p className="text-white/75">These documents explain how to take part, what content is allowed, and how Hive handles your information.</p><section className="card p-5"><h2 className="mb-4 font-bold">Table of contents</h2><PolicyLinks /></section></PolicyLayout>;
}
