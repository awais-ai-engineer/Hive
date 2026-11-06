import { notFound } from 'next/navigation';
import { PolicyLayout, policyLinks, type PolicySection } from '../../../components/policies/policy-layout';

const documents: Record<string, PolicySection[]> = {
  guidelines: [
    { id: 'respect', title: 'Treat people with respect', text: ['Listen to other people and disagree with ideas without attacking the person. Harassment, threats, hate and sharing someone’s private information without permission are not welcome.'] },
    { id: 'participation', title: 'Participate thoughtfully', text: ['Read a community’s rules before joining. Stay on topic, credit original creators, and avoid repetitive promotion or spam. Do not impersonate people or try to evade community restrictions.'] },
    { id: 'safety', title: 'Keep yourself and others safe', text: ['Do not post passwords, access tokens, home addresses or other sensitive details. Use the reporting controls when something seems harmful. Blocking someone can help limit unwanted new conversations.'] },
    { id: 'moderation', title: 'Rules and moderation', text: ['Community owners and administrators set local rules. They may remove content or restrict access when rules are broken. Report concerns with enough context for a fair review; do not organise harassment in response.'] },
  ],
  content: [
    { id: 'allowed', title: 'Share responsibly', text: ['Share content you created or have permission to use. Respect copyright, privacy and the rules of the community where you post. Make titles and links clear so people know what they are opening.'] },
    { id: 'prohibited', title: 'Content that is not allowed', text: ['Do not share illegal material, sexual exploitation, credible threats, malware, scams or instructions to harm a specific person. Do not publish private information without consent or use Hive to coordinate abuse.'] },
    { id: 'sensitive', title: 'Sensitive topics', text: ['Discuss difficult topics with care. Avoid graphic material and misleading claims that could put someone at risk. Community rules may set stricter limits for their audience.'] },
    { id: 'reports', title: 'Reports and corrections', text: ['Use the report action on a post, comment, message or profile to flag a concern. Include a short explanation. Moderators may remove content or limit an account while reviewing a report.'] },
  ],
  privacy: [
    { id: 'information', title: 'Information you provide', text: ['Hive stores account details, profile information and the content you choose to share. Authentication uses session credentials. Your email is not displayed to other members. Avoid adding sensitive information to a public profile.'] },
    { id: 'visibility', title: 'Who can see your content', text: ['Community posts are public. Workspace content is limited to members. Community chat follows its public-chat setting, and private channels are limited to the people added to them. People who can view content may copy it.'] },
    { id: 'controls', title: 'Your choices', text: ['Settings let you change profile information, interests, direct-message preferences and visible presence. You can block people and leave spaces you do not own. Clearing interests removes those saved choices.'] },
    { id: 'operations', title: 'Storage and operation', text: ['Hive uses service logs and stored content to operate the app and investigate problems. This template does not promise a fixed retention period or describe a production analytics programme. The operator must publish accurate retention, deletion and contact details before launch.'] },
  ],
  terms: [
    { id: 'account', title: 'Using an account', text: ['Keep your login details safe and use accurate information when it is needed to operate your account. You are responsible for activity you authorise. Do not access another person’s account or bypass access controls.'] },
    { id: 'content', title: 'Your content and responsibilities', text: ['You keep your rights in content you share. You give the service the permission needed to store and display that content to its intended audience. Only share material you are entitled to use, and follow the Community Guidelines and Content Policy.'] },
    { id: 'availability', title: 'Availability and changes', text: ['Hive is a developing service. Features may change or be interrupted. Keep your own copy of important material. Access may be restricted when an account breaches community rules or threatens the service.'] },
    { id: 'review', title: 'Before public launch', text: ['The operator must replace this template with reviewed terms that identify the service operator, eligibility requirements, applicable law, dispute process and contact details. This document is not legal advice.'] },
  ],
};
export function generateStaticParams() { return policyLinks.map(([policy]) => ({ policy })); }
export default async function PolicyPage({ params }: { params: Promise<{ policy: string }> }) {
  const { policy } = await params;
  const title = policyLinks.find(([slug]) => slug === policy)?.[1];
  if (!title || !documents[policy]) notFound();
  return <PolicyLayout title={title} sections={documents[policy]} />;
}
